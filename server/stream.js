'use strict';

const crypto = require('crypto');
const config = require('./config');
const tts = require('./tts');
const turn = require('./turn');
const { SentenceBuffer } = require('./sentence');
const { Timing } = require('./timing');

const SENTENCE_GAP_MS = 120; // 句间停顿,避免连续句子连珠炮式播放(前端此时无新块,自然衔接)

// 流式问答管线 + /api/chat_stream 连接处理。
// 前端连 /api/chat_stream?sessionId=xxx,发 {type:'chat', text},后端一条龙:
// 用户文本 → llm.askStream 增量 → 断句器切句 → 逐句串行 TTS(一次一句) → 顺序推裸 s16le PCM 给前端。
// 前端打断直接 close(或主动停止),后端取消 LLM 请求、停当前合成、清队列。
//
// 协议(服务端 → 客户端,严格按序):
//   1. {type:'start', userText}
//   2. {type:'meta', sampleRate, channels, bitsPerSample}(须在任何二进制帧之前)
//   3. {type:'delta', text}(LLM 增量,供流式字幕) 与 二进制帧(裸 s16le PCM)交错
//   4. {type:'done', replyText}(TTS 队列全部排空后发) 或 {type:'error', message}

function attach(wss) {
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/api/chat_stream') return; // 非流式问答,交给其他 handler
    // sessionId 可选:接入方传了就用它做多轮记忆(须传稳定值,如固定字符串,yuxi 的 thread 才能串回);
    // 不传则本连接一个独立随机会话,每次问答各自独立(无多轮记忆),也避免不同客户端共用 undefined 槽互相串话。
    const sessionId = url.searchParams.get('sessionId') || crypto.randomUUID();

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
    this.replyText = '';
    this._t = null;        // 本轮 Timing(chat_stream),用于链路耗时打点
    this._firstDelta = false;
    this._firstChunk = false;
    this._sentCount = 0;   // 已合成句数
  }

  // 开始一轮流式问答。
  start(text) {
    if (!text) return;
    this.cancel(); // 取消上一轮(若有),gen++;开始新轮
    this.replyText = '';
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
        this._waitDrain(gen, this.replyText);
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
    this._sendJson({ type: 'delta', text: delta }); // 流式字幕(可选)
    const sentences = this.splitter.push(delta);
    for (const s of sentences) this._enqueue(gen, s);
  }

  // LLM 流结束,把残余半句入队。
  _flushTail(gen) {
    for (const s of this.splitter.flush()) this._enqueue(gen, s);
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
      this._finish('done', { replyText });
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

module.exports = { attach };
