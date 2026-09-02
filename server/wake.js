'use strict';

const vad = require('./vad');
const asr = require('./asr');
const { Timing } = require('./timing');
const { pinyin } = require('pinyin-pro'); // 拼音模糊匹配,兼容 ASR 同音字误识别

// 唤醒检测:前端常驻推 16k mono int16 PCM 块,这里用流式 Silero VAD 判"开口段",
// 段结束送 ASR,归一化文本后与配置的唤醒词匹配(字符精确 + 拼音模糊,兼容同音字误识别)。
// 命中后**自动回答**:去掉唤醒词,剩余文本直接送 LLM→TTS,音频经 WS 回传前端播放(免按键)。
// 命中唤醒词即进入"唤醒窗口"(config 的 wakeTimeout,秒):窗口内再说话不用带唤醒词,
// 直接回答;窗口超时自动休眠,需重新说唤醒词。
// 唤醒词来自 server/config/{profile}.json 的 wakeWords,可配置多个、可改。

// VAD 开口/静音判定参数(threshold/startFrames/endFrames)由 config.vad 配置,默认见构造函数。
const PAD_SAMPLES = 4800; // 段前后各保留 300ms 静音,防止掐头去尾(VAD 判开口有滞后,100ms 不够,开头的短促音易被切)
const MAX_SEG_SAMPLES = 5 * 16000; // 单段上限 5s,超时强制截断
const WAKE_REPLY = '我在，请讲'; // 只说唤醒词、没带问题时的固定问候回复(不走 LLM,不写进多轮历史)

// 语义化打断词:VAD 攒段 → ASR 识别后,文本命中这些词(且整段够短)才发 interrupt,
// 让"别说了/暂停"这类指令能停播,而环境噪音/无关音不再打断。
const STOP_WORDS = ['暂停', '停一下', '停下', '停止回答', '别说了', '别讲了', '不用说了', '不要再说了', '住口', '闭嘴', '安静'];
const STOP_MAX_LEN = 6; // 命中打断词前,归一化文本长度上限,挡住正常长句问题

// 归一化:去空白/全半角标点/转小写,ASR 结果和唤醒词统一后再做包含匹配。
function normalize(s) {
  return s.replace(
    /[\s　，。！？；：、“”‘’（）【】《》〈〉〔〕……—·,.!?;:'"()\[\]{}<>@#$%^&*+=_\-~`/\\|]/g,
    ''
  ).toLowerCase();
}

// 逐字符转拼音音节(忽略声调)。汉字→拼音(如 智/志 都→zhi),非汉字→保留原字符,
// 保证每个元素与原文一个字符一一对应,拼音匹配到的窗口能精确映射回原文剥词。
function toSyllables(s) {
  const out = [];
  for (const ch of s) {
    const p = pinyin(ch, { toneType: 'none' });
    out.push(p || ch);
  }
  return out;
}

// sub 是否 syl 的连续子序列:返回起始下标,未命中返回 -1。
function findSubseq(syl, sub) {
  outer: for (let i = 0; i + sub.length <= syl.length; i++) {
    for (let j = 0; j < sub.length; j++) {
      if (syl[i + j] !== sub[j]) continue outer;
    }
    return i;
  }
  return -1;
}

// 环形缓冲:保留最近 PAD_SAMPLES 个样本,作为开口前/段尾的静音 padding。
class Ring {
  constructor(n) {
    this.buf = new Float32Array(n);
    this.pos = 0;
    this.n = n;
    this.filled = 0;
  }
  push(samples) {
    for (let i = 0; i < samples.length; i++) {
      this.buf[this.pos] = samples[i];
      this.pos = (this.pos + 1) % this.n;
    }
    this.filled = Math.min(this.filled + samples.length, this.n);
  }
  toArray() {
    const out = new Float32Array(this.filled);
    const start = this.filled >= this.n ? this.pos : 0;
    for (let i = 0; i < this.filled; i++) out[i] = this.buf[(start + i) % this.n];
    return out;
  }
}

class WakeDetector {
  constructor(wakeWords, onEvent, wakeTimeoutMs, vad = {}, stopWords, stopMaxLen) {
    this.wakeWords = wakeWords.map(normalize).filter(Boolean);
    this.wakeSyllables = this.wakeWords.map(toSyllables); // 拼音匹配用,构造时预计算一次
    // 打断词可配(config.wakeStopWords 覆盖默认),每个归一化 + 拼音预处理,供 matchStop 用。
    this.stopWords = (Array.isArray(stopWords) && stopWords.length ? stopWords : STOP_WORDS).map(normalize).filter(Boolean);
    this.stopMaxLen = stopMaxLen || STOP_MAX_LEN;
    this.stopSyllables = this.stopWords.map(toSyllables); // 打断词拼音序列,同唤醒词,用于同音字容错
    this.onEvent = onEvent; // 回调(type, payload):answer=回答、wake=命中唤醒词、sleep=已休眠
    this.wakeTimeoutMs = wakeTimeoutMs || 300000; // 唤醒窗口时长,默认 5 分钟
    // VAD 开口/静音判定(config.vad 可覆盖)。门槛太低环境噪音误触发多,
    // 门槛太高开口判定滞后、开头第一个字易被切,默认取折中。
    this.threshold = vad.threshold ?? 0.55; // 语音概率阈值,越高判语音越严格
    this.startFrames = vad.startFrames ?? 3; // 连续语音帧数判开口,约 96ms
    this.endFrames = vad.endFrames ?? 15; // 连续静音帧数判段结束,约 480ms
    this.armed = false; // 唤醒窗口内 true:说话免唤醒词直接回答
    this.lastActiveAt = 0; // 上次唤醒/回答时间,每次回答刷新,休眠倒计时按它重新计时
    this.sleepTimer = null; // 唤醒窗口休眠定时器(准点触发,主动推 sleep)
    this.ring = new Ring(PAD_SAMPLES);
    this.vadStream = null;
    this.state = 'idle'; // idle | speaking
    this.speechFrames = [];
    this.speechSamples = 0;
    this.speechStreak = 0;
    this.silentStreak = 0;
    this.classifying = false; // 前一次 ASR 未完成时不启动新的,避免堆积
  }

  // 匹配唤醒词:先按字符精确匹配(快路径),不中再按拼音匹配(忽略声调)。
  // 拼音匹配解决 ASR 同音字误识别(如「你好小智」被识别成「你好小志」,志/智拼音都是 zhi)。
  // 命中返回 { word, rest },rest=剥掉唤醒词后的剩余文本(归一化);未命中返回 null。
  match(text) {
    const n = normalize(text);
    const word = this.wakeWords.find((w) => n.includes(w));
    if (word) return { word, rest: n.replace(word, '').trim() };
    // 拼音匹配:唤醒词音节序列是文本音节序列的连续子序列。
    // 音节逐字对应原文,命中的窗口映射回 n 的字符区间剥词(唤醒词为纯中文,字符数=音节数)。
    const syl = toSyllables(n);
    for (let i = 0; i < this.wakeWords.length; i++) {
      const sub = this.wakeSyllables[i];
      if (!sub.length) continue;
      const idx = findSubseq(syl, sub);
      if (idx >= 0) {
        const w = this.wakeWords[i];
        return { word: w, rest: (n.slice(0, idx) + n.slice(idx + w.length)).trim() };
      }
    }
    return null;
  }

  // 语义化打断判定:只有"确实是打断指令"才命中——归一化后去掉某个打断词,剩余【为空或仅剩语气/代词】
  // 才算真打断(如"别说了""停下""你别说了""停一下好吗"→命中)。句子("帮我暂停一下""为什么停止播放")
  // 虽含打断词但剥词后剩有实词,视为正常话不打断——这是"外部声音/回答内容不误断"的关键。
  matchStop(text) {
    const n = normalize(text);
    if (!n || n.length > this.stopMaxLen) return false;
    // 字符精确:任一打断词剥词后只剩语气/代词才算打断指令(不因第一个命中就返回,后面可能有更能剥干净的词)。
    for (const w of this.stopWords) {
      if (n.includes(w) && this._restIsInterjection(n.replace(w, ''))) return true;
    }
    // 拼音模糊(ASR 同音,如 别硕了/别说了):命中打断词音节后,按字符窗口剥词,也需只剩语气/代词。
    // 与字符分支对称——否则会把"帮我暂停一下"(含 zan-ting 音节)误判成打断。
    const syl = toSyllables(n);
    for (let i = 0; i < this.stopSyllables.length; i++) {
      const sub = this.stopSyllables[i];
      if (!sub.length) continue;
      const idx = findSubseq(syl, sub);
      if (idx >= 0) {
        const rest = n.slice(0, idx) + n.slice(idx + this.stopWords[i].length);
        if (this._restIsInterjection(rest)) return true;
      }
    }
    if (this._isPrefixedStop(n)) return true;
    return false;
  }

  // 前缀祈使打断:归一化文本 = [礼貌/催促前缀]打断词[轻量后缀] 即判打断。
  // 拦截"暂停播放 / 帮我暂停一下 / 快停下(来)"这类带轻动作词的祈使,而"为什么停止播放 / 暂停功能怎么用"
  // 虽含打断词但剩余含"怎么/为什么/功能"等实词(不在轻量表)→ 不判,避免把疑问句当打断。
  _isPrefixedStop(n) {
    // 先剥礼貌/催促前缀("请帮我暂停一下" → "暂停一下")。
    let s = n;
    for (const p of ['请帮我', '帮我', '麻烦你', '请你', '请', '麻烦', '快', '赶紧', '立刻', '马上', '先']) {
      if (s.startsWith(p)) { s = s.slice(p.length); break; }
    }
    // 优先按配置打断词前缀(裸"暂停"也覆盖:剩余为空即 true)。
    const w = this.stopWords.find((sw) => sw && s.startsWith(sw));
    if (w) return this._isStopLight(s.slice(w.length));
    // 单字"停"前缀:用户常直接喊"停/先停/快停";剩余须全轻量,挡住"停车场/停留/停到"这类正常词。
    // 不能把"停"加进 stopWords——它的 contains 分支会误伤任何含"停"的句子,这里只在开头严格判。
    if (s.startsWith('停')) return this._isStopLight(s.slice('停'.length));
    return false;
  }

  // 打断词后的剩余若全为轻量成分(语气/代词 + "播放-说-停一下-了-点-下来"等轻动作后缀),视为祈使被打断。
  _isStopLight(rest) {
    if (rest === '') return true;
    return [...rest].every((ch) => '一下了的点吧啊哦呢啦么着停播放说掉话下来这个那个它让我给他次'.includes(ch));
  }

  // 去掉打断词后的剩余:为空,或只含语气词/代词(如"你""好""吗""吧""一下""请"),视为祈使打断;
  // 含有实词(如"帮""放"等动词)则当成请求句,不判打断。
  _restIsInterjection(rest) {
    if (rest === '') return true;
    return [...rest].every((ch) => '你我他她它的好吧吗啊呢哦请一下啦点'.includes(ch));
  }

  async init() {
    this.vadStream = await vad.createVadStream((prob, samples) => this.onFrame(prob, samples));
  }

  onFrame(prob, samples) {
    this.ring.push(samples);
    const isSpeech = prob > this.threshold;

    if (this.state === 'idle') {
      if (isSpeech) {
        this.speechStreak++;
        if (this.speechStreak >= this.startFrames) {
          // 判到开口(约 96ms)即进入攒段;不再"开口即断"——打断改为语义化:
          // 段结束 ASR 识别出打断词(见 matchStop)才发 interrupt,避免环境噪音误断。
          this.state = 'speaking';
          // 段头 padding = 已缓存的最近 100ms
          this.speechFrames = [this.ring.toArray()];
          this.speechSamples = this.ring.filled;
          this.silentStreak = 0;
        }
      } else {
        this.speechStreak = 0;
      }
      return;
    }

    this.speechFrames.push(samples);
    this.speechSamples += samples.length;
    if (isSpeech) {
      this.silentStreak = 0;
    } else {
      this.silentStreak++;
      if (this.silentStreak >= this.endFrames || this.speechSamples >= MAX_SEG_SAMPLES) {
        this.finalize();
      }
    }
  }

  finalize() {
    // 拼段:语音段 + 段尾 100ms padding(ring 里最近的静音)
    const frames = this.speechFrames;
    const tail = this.ring.toArray();
    const total = frames.reduce((s, f) => s + f.length, 0) + tail.length;
    const float = new Float32Array(total);
    let o = 0;
    for (const f of frames) {
      float.set(f, o);
      o += f.length;
    }
    float.set(tail, o);

    const int16 = new Int16Array(float.length);
    for (let i = 0; i < float.length; i++) int16[i] = Math.max(-1, Math.min(1, float[i])) * 32767;
    const wav = vad.samplesToWav(int16);

    // 重置状态,继续监听下一段
    this.state = 'idle';
    this.speechFrames = [];
    this.speechSamples = 0;
    this.speechStreak = 0;
    this.silentStreak = 0;

    this.classify(wav);
  }

  // ASR 慢(online ~1s),异步跑且串行:识别期间新段不重复发 ASR。打点 ASR 耗时。
  classify(wav) {
    if (this.classifying) return;
    this.classifying = true;
    const t = new Timing('wake');
    asr
      .recognizeBuffer(wav)
      .then((text) => {
        t.mark('ASR识别');
        t.log();
        const now = Date.now();

        // 语义化打断:识别到打断词(如"别说了")即发 interrupt,不再"任意声音即断"。
        // 命中打断词不回 answer——否则会把"暂停"当新问题送 LLM,反而自问自答。
        if (this.matchStop(text)) {
          console.log(`[wake] 检测到打断词,识别为:「${text}」`);
          // 静默停播:命中打断词即发 interrupt(不播报"已暂停",避免想安静时又多一声、
          // 以及那声被麦克风采回识别成用户输入而自问自答)。
          this.onEvent('interrupt');
          return;
        }

        if (this.armed) {
          const trimmed = text.trim();
          // 过短(<2 字)视为语气词/噪音乱码,不当新问题问答(避免环境噪音被喂给 LLM)
          if (normalize(trimmed).length < 2) return;
          // 已唤醒:整句直接送 LLM,不用再带唤醒词。
          // 若还带着唤醒词(习惯性带上),剥掉再送(字符/拼音匹配均可)。
          this.lastActiveAt = now;
          this._scheduleSleep(); // 窗口内每次说话刷新休眠倒计时
          const m = this.match(trimmed);
          this.answer(m ? m.rest : trimmed, m ? m.word : undefined);
          return;
        }

        // 未唤醒:必须匹配唤醒词才回答,否则整段丢弃。
        const m = this.match(text);
        if (!m) {
          console.log(`[wake] 未命中唤醒词,识别为:「${text}」`);
          return;
        }
        this.armed = true;
        this.lastActiveAt = now;
        this._scheduleSleep();
        this.onEvent('wake', { word: m.word, timeoutSeconds: Math.round(this.wakeTimeoutMs / 1000) });
        this.answer(m.rest, m.word);
      })
      .catch((e) => console.error(`[wake] 唤醒段识别失败: ${e.message}`))
      .finally(() => {
        this.classifying = false;
      });
  }

  // 唤醒窗口休眠倒计时:命中唤醒词或窗口内每次回答都会重置。到点主动推 sleep,
  // 不用等用户下一句开口才判超时(旧行为:静默超时后前端已显示休眠,后端却还没真正睡)。
  _scheduleSleep() {
    if (this.sleepTimer) clearTimeout(this.sleepTimer);
    this.sleepTimer = setTimeout(() => {
      this.sleepTimer = null;
      if (!this.armed) return;
      this.armed = false;
      this.onEvent('sleep', { idleSeconds: Math.round((Date.now() - this.lastActiveAt) / 1000) });
    }, this.wakeTimeoutMs);
  }

  // 连接关闭时清掉休眠定时器,避免残留回调。
  close() {
    if (this.sleepTimer) {
      clearTimeout(this.sleepTimer);
      this.sleepTimer = null;
    }
  }

  // 只说唤醒词、没带问题:直接回固定问候(带 replyText),不走 LLM,避免把「我在，请讲」当用户消息写进多轮历史。
  // 带问题:不再整段调 LLM,只回 userText,由前端连 /api/chat_stream 流式问答(与语音路一致,共享多轮记忆)。
  answer(question, word) {
    if (!question) {
      this.onEvent('answer', { userText: word || WAKE_REPLY, replyText: WAKE_REPLY });
      return;
    }
    this.onEvent('answer', { userText: question });
  }
}

// 挂到共享 WebSocketServer(无 path,这里过滤 /api/wake)。前端连上后持续发二进制 int16 块。
function attach(wss, wakeWords, wakeTimeoutSec, vad = {}, stopWords, stopMaxLen) {
  const words = Array.isArray(wakeWords) ? wakeWords : [];
  const timeoutMs = (wakeTimeoutSec && wakeTimeoutSec > 0 ? wakeTimeoutSec : 300) * 1000;
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/api/wake') return; // 非唤醒连接,交给其他 handler(如 /api/tts)
    const detector = new WakeDetector(words, (type, payload) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify({ type, ...payload }));
    }, timeoutMs, vad, stopWords, stopMaxLen);
    // init 异步加载 ONNX 模型(数百 ms),消息到达时等它就绪再喂,避免丢帧
    const ready = detector.init().catch((e) => {
      console.error('[wake] 初始化失败:', e.message);
      ws.close();
    });

    // feed 串行化:并发喂帧会互相覆盖共享的 state/pending,导致检测错乱。
    // chain 从 ready 开始,消息按到达顺序排队处理。
    let chain = ready;
    ws.on('close', () => detector.close()); // 断开时清休眠定时器,避免残留回调
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        // 手动唤醒:前端点按钮发 {"type":"wake_manual"},免唤醒词直接进入唤醒窗口。
        // 用于唤醒词一直检测不到时兜底:点一下=说了唤醒词,窗口内直接说话即可回答。
        try {
          const msg = JSON.parse(data.toString());
          if (msg && msg.type === 'wake_manual') {
            detector.armed = true;
            detector.lastActiveAt = Date.now();
            detector._scheduleSleep(); // 重置窗口倒计时
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({
                type: 'wake',
                word: '(手动唤醒)',
                timeoutSeconds: Math.round(timeoutMs / 1000)
              }));
            }
          }
        } catch (e) {
          console.warn('[wake] 非法消息:', e.message);
        }
        return;
      }
      // Buffer → Int16Array(16k mono s16le)
      const int16 = new Int16Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 2));
      chain = chain
        .then(() => detector.vadStream.feed(int16))
        .catch((e) => console.error('[wake] feed:', e.message));
    });
  });
}

// 导出 attach 供 index.js 挂载;WakeDetector 与纯文本匹配函数导出供测试(test/)用,无副作用。
module.exports = { attach, WakeDetector, _test: { normalize, toSyllables, findSubseq } };
