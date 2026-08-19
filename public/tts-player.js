'use strict';

// 流式 TTS 播放器:拿 replyText → 连 /api/tts WS 流式合成 → Web Audio 排队播放。
// 用法:
//   const ttsPlayer = new TtsPlayer();
//   ttsPlayer.onError = (msg) => showError('TTS 失败:' + msg);
//   ttsPlayer.play(replyText);   // 边生成边播,重复调用自动打断旧回答
//   ttsPlayer.stop();            // 手动打断
//   ttsPlayer.playing            // 播放期间为 true
//
// 关键点(别改):播放起点必须等首个 PCM 块到达时才定为 ctx.currentTime + 0.15。
// 若在 play() 开始时预设起点,TTS 首块要等 ~800ms 才到,start() 拿到的是过期时间戳,
// 会被浏览器立即播,前几块互相重叠,开头听感变快/发糊(曾踩过)。
(function (global) {
  const DEBUG = true; // 诊断日志开关,排查用;上线可关

  class TtsPlayer {
    constructor() {
      this._playGen = 0;            // 每次新播放递增;旧 gen 的音块/音频全部失效
      this._audioCtx = null;        // 播放用 AudioContext(24000Hz,与后端 PCM 一致)
      this._ttsWs = null;           // 当前 /api/tts 连接
      this._ttsSampleRate = 24000;  // 收 meta 后更新为 config.tts.sampleRate
      this._nextTime = 0;           // 下个音块的预定播放时刻
      this._activeSources = new Set();
      this._playing = false;
      this.onStateChange = null;    // (playing:boolean) 可选,播放开始/结束回调
      this.onError = null;          // (msg:string) TTS 失败/连接异常
      this.onDone = null;           // () 可选,合成完成回调
    }

    get playing() { return this._playing; }

    async _ensureAudioCtx() {
      if (!this._audioCtx) {
        // 播放 ctx 固定 24000,与后端 PCM 一致:零重采样,避免音调/语速异常
        // (24k 数据在 44.1k/48k ctx 播会变快,16k 播会变慢)。
        try {
          this._audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
        } catch {
          this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
      }
      // 必须等 resume 完成:ctx 挂起时 currentTime 冻结,拿冻结值算调度时间会排错队。
      if (this._audioCtx.state === 'suspended') await this._audioCtx.resume();
      return this._audioCtx;
    }

    _setPlaying(v) {
      if (this._playing === v) return;
      this._playing = v;
      if (this.onStateChange) this.onStateChange(v);
    }

    stop() {
      this._playGen++;              // 旧 gen 全部失效
      if (this._ttsWs) { try { this._ttsWs.close(); } catch {} this._ttsWs = null; }
      this._activeSources.forEach((s) => { try { s.stop(); } catch {} });
      this._activeSources.clear();
      this._nextTime = 0;
      this._setPlaying(false);
    }

    async play(text) {
      this.stop();
      const gen = this._playGen;
      const ctx = await this._ensureAudioCtx(); // await resume,确保 currentTime 是真实时钟
      if (gen !== this._playGen) return;        // await 期间被打断,丢弃
      this._setPlaying(true);                   // 播放会话开始
      if (DEBUG) console.log('[play] start textLen=' + text.length + ' ctx.sr=' + ctx.sampleRate + ' now=' + ctx.currentTime.toFixed(3));
      let pcmN = 0;
      const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/tts';
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      this._ttsWs = ws;
      ws.onopen = () => ws.send(JSON.stringify({ type: 'synthesize', text }));
      ws.onmessage = (e) => {
        if (gen !== this._playGen) return; // 已打断,丢弃旧合成
        if (typeof e.data === 'string') {
          const msg = JSON.parse(e.data);
          if (msg.type === 'meta') this._ttsSampleRate = msg.sampleRate || this._ttsSampleRate;
          else if (msg.type === 'error') { if (this.onError) this.onError(msg.message); }
          else if (msg.type === 'done') { if (DEBUG) console.log('[play] done'); ws.close(); if (this.onDone) this.onDone(); }
          return;
        }
        // 二进制 = 裸 s16le PCM。播放起点在首块到达时才定:此刻 currentTime 才是真实时钟,
        // +150ms 给后续排队留余量。若在 play() 时预设起点,首块要等 TTS 生成 ~800ms 才到,
        // start(过去时间)被浏览器立即播,前几块互相接近重叠,开头听感错乱(变快/发糊)。
        if (pcmN === 0) this._nextTime = Math.max(this._nextTime, ctx.currentTime + 0.15);
        const int16 = new Int16Array(e.data);
        const f32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768;
        const buf = ctx.createBuffer(1, f32.length, this._ttsSampleRate);
        buf.copyToChannel(f32, 0);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        this._activeSources.add(src);
        src.onended = () => {
          this._activeSources.delete(src);
          if (this._activeSources.size === 0 && gen === this._playGen) this._setPlaying(false);
        };
        src.start(this._nextTime);
        if (DEBUG) console.log('[pcm]', ++pcmN, 'n=' + f32.length, 'dur=' + (buf.duration * 1000).toFixed(0) + 'ms',
          'next=' + this._nextTime.toFixed(3), 'now=' + ctx.currentTime.toFixed(3),
          'drift=' + ((this._nextTime - ctx.currentTime) * 1000).toFixed(0) + 'ms');
        this._nextTime += buf.duration;
      };
      ws.onclose = () => {
        if (DEBUG) console.log('[play] ws closed, activeSources=' + this._activeSources.size);
        if (this._ttsWs === ws) this._ttsWs = null;
        if (this._activeSources.size === 0 && gen === this._playGen) this._setPlaying(false);
      };
      ws.onerror = () => { if (gen === this._playGen && this.onError) this.onError('TTS 连接异常'); };
    }
  }

  global.TtsPlayer = TtsPlayer;
})(window);
