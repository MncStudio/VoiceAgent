'use strict';

const config = require('./config');
const tts = require('./tts');
const turn = require('./turn');
const speech = require('./speech');
const llm = require('./llm');
const { SentenceBuffer } = require('./sentence');
const { Timing } = require('./timing');

const SENTENCE_GAP_MS = 120; // 句间停顿,避免连续句子连珠炮式播放(前端此时无新块,自然衔接)

// 流式问答管线 + /api/chat_stream 连接处理。
// 前端连 /api/chat_stream,发 {type:'chat', text},后端一条龙:
// 用户文本 → llm.askStream 增量 → 断句器切句 → 逐句串行 TTS(一次一句) → 顺序推裸 s16le PCM 给前端。
// 前端打断直接 close(或主动停止),后端取消 LLM 请求、停当前合成、清队列。
//
// 显示与播报在这里分流(见 speech.js):
//   delta / done.replyText = LLM 完整回复 → 前端弹窗与字幕显示完整;
//   推给前端的 PCM / done.speechText = 精简后的播报文本(config.speech.mode,默认只念含数字的片段)。
//
// 协议(服务端 → 客户端,严格按序):
//   1. {type:'start', userText}
//   2. {type:'meta', sampleRate, channels, bitsPerSample}(须在任何二进制帧之前)
//   3. {type:'delta', text}(LLM 增量,完整文本,供流式字幕) 与 二进制帧(裸 s16le PCM)交错
//   4. {type:'done', replyText, speechText}(TTS 队列全部排空后发) 或 {type:'error', message}

function attach(wss) {
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/api/chat_stream') return; // 非流式问答,交给其他 handler
    // sessionId 可选:接入方传固定值则据此续 yuxi 多轮记忆(存 thread_id);不传则每次单轮。
    const sessionId = url.searchParams.get('sessionId') || undefined;
    const pipeline = new StreamPipeline(ws, sessionId);
    ws.on('close', () => pipeline.cancel());
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg && msg.type === 'chat' && msg.text) {
        pipeline.start(String(msg.text).trim());
      }
    });
  });
}

class StreamPipeline {
  constructor(ws, sessionId) {
    this.ws = ws;
    this.sessionId = sessionId;
    this.splitter = new SentenceBuffer({
      maxLen: config.llm?.maxSentenceLen || 80,
      minLen: config.llm?.minSentenceLen || 5, // 短于此的句暂缓合并,减少碎句/请求数(防限流)
    });
    this.queue = [];       // 待合成句子(FIFO,一次只合成一句)
    this.active = null;    // 当前 tts.synthesizeStream 的 {promise, cancel}
    this.gen = 0;          // 管线世代:打断/新请求都 +1,旧异步续体全部失效
    this.llmController = null;
    this.userText = '';    // 本轮用户问题(播报改写提示里要带)
    this.replyText = '';   // 完整回复(显示用)
    this.speechText = '';  // 实际播报文本(精简后,可能为空→走兜底)
    this.spokenAny = false;// 是否已产出过带单位的关键数字(正文播报)
    this.plainFallback = []; // 只有数字没单位的片段(表格行/ID/日期),整段没有关键数字时才兜底播
    this._t = null;        // 本轮 Timing(chat_stream),用于链路耗时打点
    this._firstDelta = false;
    this._firstChunk = false;
    this._sentCount = 0;   // 已合成句数
  }

  get speechMode() {
    return speech.normalizeMode(config.speech && config.speech.mode);
  }

  // 开始一轮流式问答。
  start(text) {
    if (!text) return;
    this.cancel(); // 取消上一轮(若有),gen++;开始新轮
    this.userText = text;
    this.replyText = '';
    this.speechText = '';
    this.spokenAny = false;
    this.plainFallback = [];
    const gen = this.gen;

    this._sendJson({ type: 'start', userText: text });
    // meta 必须先于任何二进制帧,前端解码依赖采样率/声道/位深。
    this._sendJson({
      type: 'meta',
      sampleRate: config.tts.sampleRate,
      channels: config.tts.channels,
      bitsPerSample: config.tts.bitsPerSample,
    });

    const t = new Timing('chat_stream');
    this._t = t;
    this._firstDelta = false;
    this._firstChunk = false;
    this._sentCount = 0;
    this.llmController = new AbortController();
    turn
      .askStream(text, this.sessionId, (delta) => this._onDelta(gen, delta), this.llmController.signal)
      .then(({ replyText }) => {
        if (gen !== this.gen) return; // 已被打断,丢弃
        t.mark('LLM完成');
        this.replyText = replyText || '';
        this._flushTail(gen);
        if (this.speechMode === 'llm') {
          this._speakSummary(gen); // 单独 LLM 链路改写播报文本，内部再 _waitDrain
        } else {
          this._fallbackSpeakFull(gen);
          this._waitDrain(gen, this.replyText);
        }
      })
      .catch((e) => {
        if (gen !== this.gen) return; // 打断导致的 reject,不报错
        t.mark('LLM失败');
        t.log();
        this._finish('error', { message: e.message });
      });
  }

  _onDelta(gen, delta) {
    if (gen !== this.gen) return;
    if (!this._firstDelta) { this._firstDelta = true; this._t.mark('LLM首字'); }
    this.replyText += delta;
    this._sendJson({ type: 'delta', text: delta }); // 流式字幕:完整文本,弹窗照全文显示
    const sentences = this.splitter.push(delta);
    for (const s of sentences) this._enqueueSpeech(gen, s);
  }

  // LLM 流结束,把残余半句入队。
  _flushTail(gen) {
    for (const s of this.splitter.flush()) this._enqueueSpeech(gen, s);
  }

  // 一句显示文本 → 播报文本后入队。
  // 带业务单位的"关键数字"立刻播（保住流式低延迟）；只有数字没单位的片段（表格行/ID/日期/序号）
  // 先攒进 plainFallback——整段回复都没有关键数字时才拿出来兜底，否则它们会被逐句念出来。
  _enqueueSpeech(gen, sentence) {
    if (gen !== this.gen) return;
    const mode = this.speechMode;
    if (mode === 'llm') return; // 播报文本交给 _speakSummary 整段改写，这里不逐句播
    if (mode === 'full') {
      this.spokenAny = true;
      this.speechText += sentence;
      this._enqueue(gen, sentence);
      return;
    }
    const { withUnit, plain } = speech.speechParts(sentence, mode);
    if (withUnit) {
      this.spokenAny = true;
      this.speechText += withUnit;
      this._enqueue(gen, withUnit);
      return;
    }
    if (plain) this.plainFallback.push(plain);
  }

  // speech.mode = 'llm'：主回答完整后，再走一条**单独的 LLM 链路**把显示文本改写成口语播报文本
  // （角色提示见 speech.buildSummaryPrompt：数字人播报员、不念表格/代码/Markdown）；
  // 显示文本(delta/done.replyText)保持完整不动，只有 TTS 用改写后的文本。
  // 改写失败 → 退回规则精简(key-numbers) → 再不行播完整回复。
  async _speakSummary(gen) {
    if (gen !== this.gen) return;
    const cfg = (config.speech && config.speech.summary) || null;
    let spoken = '';
    try {
      const { system, user } = speech.buildSummaryPrompt(this.replyText, this.userText, cfg || {});
      spoken = await llm.askOnce(user, { config: cfg || undefined, system });
    } catch (e) {
      console.warn('[chat_stream] 播报改写失败,退回规则精简:', e.message);
    }
    if (gen !== this.gen) return; // 改写期间被新提问/打断,丢弃
    const clean = speech.stripMarkup(spoken || '');
    if (clean) {
      this.spokenAny = true;
      this.speechText = clean;
      for (const s of this._splitSentences(clean)) this._enqueue(gen, s);
    } else if (!this._speakRuleBased(gen)) {
      this._fallbackSpeakFull(gen);
    }
    this._waitDrain(gen, this.replyText);
  }

  // 规则精简兜底：优先带单位的数字片段，其次纯数字片段；都没有返回 false
  _speakRuleBased(gen) {
    const { withUnit, plain } = speech.speechParts(this.replyText, 'key-numbers');
    const text = withUnit || plain;
    if (!text) return false;
    this.spokenAny = true;
    this.speechText += text;
    for (const s of this._splitSentences(text)) this._enqueue(gen, s);
    return true;
  }

  // 一段播报文本 → 按句切开入队（复用断句器，保证 TTS 一句一句合成）
  _splitSentences(text) {
    const buf = new SentenceBuffer({
      maxLen: config.llm?.maxSentenceLen || 80,
      minLen: config.llm?.minSentenceLen || 5,
    });
    const parts = buf.push(String(text || ''));
    parts.push(...buf.flush());
    return parts.length ? parts : [String(text || '').trim()].filter(Boolean);
  }

  // 兜底(两级),避免"有问无声",也避免把表格行念一堆:
  //   1) 整段没有带单位的关键数字,但有纯数字片段 → 播这些纯数字（已是精简后的）;
  //   2) 连数字都没有(纯寒暄/纯文字结论) → 按句播完整回复。
  // speech = 'full' 或已经有正文播报时直接跳过。
  _fallbackSpeakFull(gen) {
    if (gen !== this.gen) return;
    if (this.speechMode === 'full' || this.spokenAny) return;
    const plain = (this.plainFallback || []).join('').trim();
    if (plain) {
      const buf = new SentenceBuffer({
        maxLen: config.llm?.maxSentenceLen || 80,
        minLen: config.llm?.minSentenceLen || 5,
      });
      const parts = buf.push(plain);
      parts.push(...buf.flush());
      for (const s of parts.length ? parts : [plain]) {
        this.spokenAny = true;
        this.speechText += s;
        this._enqueue(gen, s);
      }
      return;
    }
    const full = speech.toSpeechText(this.replyText, 'full');
    if (!full) return;
    const tail = new SentenceBuffer({
      maxLen: config.llm?.maxSentenceLen || 80,
      minLen: config.llm?.minSentenceLen || 5,
    });
    const parts = tail.push(full);
    parts.push(...tail.flush());
    for (const s of parts.length ? parts : [full]) {
      this.spokenAny = true;
      this.speechText += s;
      this._enqueue(gen, s);
    }
  }

  _enqueue(gen, text) {
    if (gen !== this.gen) return;
    const s = text.trim();
    if (!s) return;
    this.queue.push(s);
    this._pump(gen);
  }

  // 逐句串行:一次只合成一句,前句结束才取下一句,保证播放顺序(避免各句耗时不同导致乱序)。
  _pump(gen) {
    if (gen !== this.gen) return;
    if (this.active) return;
    const next = this.queue.shift();
    if (!next) return;
    const ws = this.ws;
    const s0 = Date.now();
    this.active = tts.synthesizeStream(next, (chunk) => {
      if (gen !== this.gen) return;
      if (!this._firstChunk) { this._firstChunk = true; this._t.mark('TTS首块'); }
      if (ws.readyState === ws.OPEN) ws.send(chunk);
    });
    this.active.promise
      .catch((e) => { console.error('[chat_stream] 单句合成失败:', e.message); }) // 单句失败继续下一句(容错)
      .finally(() => {
        if (gen !== this.gen) return; // ★ await 之后必须再校验,防取消竞态
        this.active = null;
        this._sentCount++;
        console.log(`[chat_stream] 第${this._sentCount}句「${next.slice(0, 20)}」合成 ${Date.now() - s0}ms`);
        // 句间小停顿:合成下一句前留档,让前端音频自然衔接(也防 _nextTime 超前连播)
        setTimeout(() => this._pump(gen), SENTENCE_GAP_MS);
      });
  }

  // 等 TTS 队列全部排空(所有句合成完)才发 done——LLM 结束不代表音频播完。
  _waitDrain(gen, replyText) {
    if (gen !== this.gen) return;
    if (this.queue.length === 0 && !this.active) {
      this._t.mark('全部合成完');
      this._t.log();
      this._finish('done', { replyText, speechText: this.speechText });
      return;
    }
    setTimeout(() => this._waitDrain(gen, replyText), 50);
  }

  _finish(kind, payload) {
    this.cancel(); // 收尾:停合成/清队列/gen++,此后无残留异步续体
    this._sendJson({ type: kind, ...payload });
  }

  // 打断/结束:使所有异步续体失效,中止 LLM 请求,停当前合成,清队列,复位断句器。
  cancel() {
    this.gen++;
    if (this.llmController) { this.llmController.abort(); this.llmController = null; }
    if (this.active) { this.active.cancel(); this.active = null; }
    this.queue = [];
    this.splitter.reset();
  }

  _sendJson(obj) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(obj));
  }
}

// StreamPipeline 导出供单测用(test/stream-speech.test.js 桩掉 LLM/TTS 驱动整条管线),无副作用。
module.exports = { attach, StreamPipeline };
