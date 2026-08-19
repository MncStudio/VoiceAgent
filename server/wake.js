'use strict';

const vad = require('./vad');
const asr = require('./asr');
const turn = require('./turn');
const { Timing } = require('./timing');
const { pinyin } = require('pinyin-pro'); // 拼音模糊匹配,兼容 ASR 同音字误识别

// 唤醒检测:前端常驻推 16k mono int16 PCM 块,这里用流式 Silero VAD 判"开口段",
// 段结束送 ASR,归一化文本后与配置的唤醒词匹配(字符精确 + 拼音模糊,兼容同音字误识别)。
// 命中后**自动回答**:去掉唤醒词,剩余文本直接送 LLM→TTS,音频经 WS 回传前端播放(免按键)。
// 命中唤醒词即进入"唤醒窗口"(config 的 wakeTimeout,秒):窗口内再说话不用带唤醒词,
// 直接回答;窗口超时自动休眠,需重新说唤醒词。
// 唤醒词来自 server/config/{profile}.json 的 wakeWords,可配置多个、可改。

const THRESHOLD = 0.5; // VAD 语音概率阈值
const START_FRAMES = 3; // 连续语音帧数 → 判开口(约 96ms)
const END_FRAMES = 15; // 连续静音帧数 → 判段结束(约 480ms)
const PAD_SAMPLES = 1600; // 段前后各保留 100ms 静音,防止掐头去尾
const MAX_SEG_SAMPLES = 5 * 16000; // 单段上限 5s,超时强制截断
const WAKE_REPLY = '我在，请讲'; // 只说唤醒词、没带问题时发给 LLM 的固定输入

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
  constructor(wakeWords, sessionId, onEvent, wakeTimeoutMs) {
    this.wakeWords = wakeWords.map(normalize).filter(Boolean);
    this.wakeSyllables = this.wakeWords.map(toSyllables); // 拼音匹配用,构造时预计算一次
    this.sessionId = sessionId; // 唤醒自动回答与语音/文字共享多轮记忆
    this.onEvent = onEvent; // 回调(type, payload):answer=回答、wake=命中唤醒词、sleep=已休眠
    this.wakeTimeoutMs = wakeTimeoutMs || 300000; // 唤醒窗口时长,默认 5 分钟
    this.armed = false; // 唤醒窗口内 true:说话免唤醒词直接回答
    this.lastActiveAt = 0; // 上次唤醒/回答时间,超时判定依据
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

  async init() {
    this.vadStream = await vad.createVadStream((prob, samples) => this.onFrame(prob, samples));
  }

  onFrame(prob, samples) {
    this.ring.push(samples);
    const isSpeech = prob > THRESHOLD;

    if (this.state === 'idle') {
      if (isSpeech) {
        this.speechStreak++;
        if (this.speechStreak >= START_FRAMES) {
          // 判到开口(约 96ms)立即通知前端打断正在播的回答,不等整句识别完。
          // 检测由后端 VAD 统一做(前端不判音量):开口即打断,前端收到 interrupt 停播放。
          this.onEvent('interrupt');
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
      if (this.silentStreak >= END_FRAMES || this.speechSamples >= MAX_SEG_SAMPLES) {
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
    const t = new Timing(`wake[${this.sessionId || '-'}]`);
    asr
      .recognizeBuffer(wav)
      .then((text) => {
        t.mark('ASR识别');
        t.log();
        const now = Date.now();

        // 唤醒窗口超时 → 休眠,需重新说唤醒词。在下一个开口段识别后判定。
        if (this.armed && now - this.lastActiveAt > this.wakeTimeoutMs) {
          this.armed = false;
          this.onEvent('sleep');
        }

        if (this.armed) {
          // 已唤醒:整句直接送 LLM,不用再带唤醒词。
          // 若还带着唤醒词(习惯性带上),剥掉再送(字符/拼音匹配均可)。
          this.lastActiveAt = now;
          const m = this.match(text);
          this.answer(m ? m.rest : text.trim(), m ? m.word : undefined);
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
        this.onEvent('wake', { word: m.word });
        this.answer(m.rest, m.word);
      })
      .catch((e) => console.error(`[wake] 唤醒段识别失败: ${e.message}`))
      .finally(() => {
        this.classifying = false;
      });
  }

  // 去掉唤醒词后送 LLM。音频由前端经 /api/tts 流式合成播放,这里只回文本。
  answer(question, word) {
    const input = question || WAKE_REPLY;
    turn
      .ask(input, this.sessionId)
      .then(({ replyText }) => {
        this.onEvent('answer', { userText: question || word || input, replyText });
      })
      .catch((e) => console.error(`[wake] 回答失败: ${e.message}`));
  }
}

// 挂到共享 WebSocketServer(无 path,这里过滤 /api/wake)。前端连上后持续发二进制 int16 块。
function attach(wss, wakeWords, wakeTimeoutSec) {
  const words = Array.isArray(wakeWords) ? wakeWords : [];
  const timeoutMs = (wakeTimeoutSec && wakeTimeoutSec > 0 ? wakeTimeoutSec : 300) * 1000;
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/api/wake') return; // 非唤醒连接,交给其他 handler(如 /api/tts)
    // 前端连 /api/wake 时带 sessionId,唤醒自动回答与语音/文字共享多轮记忆
    const sessionId = url.searchParams.get('sessionId') || undefined;
    const detector = new WakeDetector(words, sessionId, (type, payload) => {
      ws.send(JSON.stringify({ type, ...payload }));
    }, timeoutMs);
    // init 异步加载 ONNX 模型(数百 ms),消息到达时等它就绪再喂,避免丢帧
    const ready = detector.init().catch((e) => {
      console.error('[wake] 初始化失败:', e.message);
      ws.close();
    });

    // feed 串行化:并发喂帧会互相覆盖共享的 state/pending,导致检测错乱。
    // chain 从 ready 开始,消息按到达顺序排队处理。
    let chain = ready;
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      // Buffer → Int16Array(16k mono s16le)
      const int16 = new Int16Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 2));
      chain = chain
        .then(() => detector.vadStream.feed(int16))
        .catch((e) => console.error('[wake] feed:', e.message));
    });
  });
}

module.exports = { attach };
