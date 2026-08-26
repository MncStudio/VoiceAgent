'use strict';

// VoiceAgent 前端 SDK(自包含单文件,不依赖 tts-player.js)。
// 接入方只需 <script src="/voice-agent.js"> + new VoiceAgent(...),即可使用三路问答:
//   唤醒监听(/api/wake WS)、按住说话(/api/chat)、文字问答(/api/chat_stream 流式),
//   回复文本自动经 /api/tts WS 流式合成播放(边生成边播,重复调用自动打断)。
//
// 用法:
//   const agent = new VoiceAgent({
//     baseUrl: '…',          // 可选;后端地址(如 http://192.168.1.5:3000),跨域/独立部署时填;缺省同源相对路径
//     autoWake: true,        // 可选;true 则构造后自动开始唤醒监听
//     onUserText(text),      // 识别到用户说的话(三路都触发)
//     onReply(text),         // 得到回复文本(已自动 TTS 播放)
//     onWake(word, timeoutSeconds),  // 命中唤醒词;timeoutSeconds=唤醒窗口总秒数
//     onSleep(idleSeconds),          // 唤醒窗口超时;idleSeconds=实际静默秒数
//     onInterrupt(),         // 开口打断正在播的回答
//     onStateChange(state),  // 状态变化:idle/starting/waiting-activation/listening/wake-active/sleep/recording/speaking
//     onError(msg),
//   });
//
//   agent.startWake();       // Promise<void>:开始唤醒监听(采集常开)
//   agent.stopWake();        // void
//   agent.wakeActive;        // boolean:唤醒监听是否开启
//   agent.askText(text);     // Promise<{replyText,userText}>:文字问答,自动播放
//   agent.startRecording();  // Promise<void>:按住说话开始
//   agent.stopRecording();   // Promise<{replyText,userText}|null>:松开发送,自动播放
//   agent.stopPlay();        // void:手动打断当前播放(保底,在播时触发 onInterrupt)

(function (global) {
  // ============ TtsPlayer:流式 TTS 播放(内联,私有,不挂 window) ============
  // 拿 replyText → 连 /api/tts WS 流式合成 → Web Audio 排队播放。
  // 关键点(别改):播放起点必须等首个 PCM 块到达时才定为 ctx.currentTime + 0.15。
  // 若在 play() 开始时预设起点,TTS 首块要等 ~800ms 才到,start() 拿到的是过期时间戳,
  // 会被浏览器立即播,前几块互相重叠,开头听感变快/发糊(曾踩过)。
  class TtsPlayer {
    constructor(baseUrl = '') {
      this._baseUrl = String(baseUrl).replace(/\/+$/, ''); // 跨域部署时后端地址;空则同源
      this._playGen = 0;            // 每次新播放递增;旧 gen 的音块/音频全部失效
      this._audioCtx = null;        // 播放用 AudioContext(24000Hz,与后端 PCM 一致)
      this._ttsWs = null;           // 当前 /api/tts 连接
      this._ttsSampleRate = 24000;  // 收 meta 后更新为 config.tts.sampleRate
      this._nextTime = 0;           // 下个音块的预定播放时刻
      this._pending = null;         // 流式块累积缓冲:服务端块不保证 2 字节对齐,跨块拼整采样
      this._pcmCount = 0;           // 累计已调度块数,首块到达时才定播放起点
      this._activeSources = new Set();
      this._playing = false;
      this._out = null;             // 播放汇流 Gain(扬声器 + MediaStreamAudioDestination)
      this._dest = null;            // 播放输出流,暴露给外部驱动口型同步等
      this.onStateChange = null;    // (playing:boolean) 可选,播放开始/结束回调
      this.onError = null;          // (msg:string) TTS 失败/连接异常
      this.onDone = null;           // () 可选,合成完成回调(playStream 下带 replyText)
      this.onReplyDelta = null;     // (text) 可选,流式字幕增量
      this.onAudioStream = null;    // (stream:MediaStream) 可选,播放流创建后回调
    }

    get playing() { return this._playing; }

    get audioStream() { return this._dest ? this._dest.stream : null; }

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
      // 播放汇流:同一 AudioContext 只建一次,stream 稳定;每块源都连 _out,
      // 经 _dest 出流供外部消费(Live2D 口型同步等),不影响扬声器输出与排队计时。
      if (!this._out || !this._dest) {
        this._out = this._audioCtx.createGain();
        this._dest = this._audioCtx.createMediaStreamDestination();
        this._out.connect(this._audioCtx.destination);
        this._out.connect(this._dest);
        if (this.onAudioStream) this.onAudioStream(this._dest.stream);
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
      this._pending = null; // 清残留累积字节
      this._pcmCount = 0;
      this._setPlaying(false);
    }

    async play(text) {
      this.stop();
      const gen = this._playGen;
      const ctx = await this._ensureAudioCtx(); // await resume,确保 currentTime 是真实时钟
      if (gen !== this._playGen) return;        // await 期间被打断,丢弃
      this._setPlaying(true);                   // 播放会话开始
      const url = this._baseUrl
        ? this._baseUrl.replace(/^http/, 'ws') + '/api/tts'
        : (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/tts';
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      this._ttsWs = ws;
      ws.onopen = () => ws.send(JSON.stringify({ type: 'synthesize', text }));
      ws.onmessage = (e) => {
        if (gen !== this._playGen) return; // 已打断,丢弃旧合成
        if (typeof e.data === 'string') {
          const msg = JSON.parse(e.data);
          if (msg.type === 'meta') this._applyMeta(msg);
          else if (msg.type === 'error') { if (this.onError) this.onError(msg.message); }
          else if (msg.type === 'done') { ws.close(); if (this.onDone) this.onDone(); }
          return;
        }
        this._consumePcm(gen, ctx, e.data);
      };
      ws.onclose = () => {
        if (this._ttsWs === ws) this._ttsWs = null;
        if (this._activeSources.size === 0 && gen === this._playGen) this._setPlaying(false);
      };
      ws.onerror = () => { if (gen === this._playGen && this.onError) this.onError('TTS 连接异常'); };
    }

    // 流式问答:连 /api/chat_stream,后端一条龙(LLM 增量→断句→逐句 TTS→顺序推 PCM),这里只播。
    // onopen 发 initialMessage(如 {type:'chat', text});done 事件回带完整 replyText,回调 onDone(replyText)。
    async playStream(wsUrl, initialMessage) {
      this.stop();
      const gen = this._playGen;
      const ctx = await this._ensureAudioCtx(); // await resume,确保 currentTime 是真实时钟
      if (gen !== this._playGen) return;        // await 期间被打断,丢弃
      this._setPlaying(true);
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      this._ttsWs = ws;
      ws.onopen = () => ws.send(JSON.stringify(initialMessage));
      ws.onmessage = (e) => {
        if (gen !== this._playGen) return;
        if (typeof e.data === 'string') {
          const msg = JSON.parse(e.data);
          if (msg.type === 'start') return;
          if (msg.type === 'meta') this._applyMeta(msg);
          else if (msg.type === 'delta') { if (this.onReplyDelta) this.onReplyDelta(msg.text); }
          else if (msg.type === 'error') { if (this.onError) this.onError(msg.message); }
          else if (msg.type === 'done') { ws.close(); if (this.onDone) this.onDone(msg.replyText); }
          return;
        }
        this._consumePcm(gen, ctx, e.data);
      };
      ws.onclose = () => {
        if (this._ttsWs === ws) this._ttsWs = null;
        if (this._activeSources.size === 0 && gen === this._playGen) this._setPlaying(false);
      };
      ws.onerror = () => { if (gen === this._playGen && this.onError) this.onError('TTS 连接异常'); };
    }

    _applyMeta(msg) {
      this._ttsSampleRate = msg.sampleRate || this._ttsSampleRate;
    }

    // 裸 s16le PCM 块 → 跨块 2 字节对齐 → Web Audio 按序调度播放。
    // 服务端流式块不保证 2 字节对齐(实测有奇数块),直接 new Int16Array 会 RangeError;
    // 先跨块累积成整采样再播。播放起点在首块到达时才定:此刻 currentTime 才是真实时钟,
    // +150ms 给后续排队留余量(理由见类头注释);后续块沿用递增的 _nextTime。
    _consumePcm(gen, ctx, raw) {
      const prevLen = this._pending ? this._pending.length : 0;
      const merged = new Uint8Array(prevLen + raw.byteLength);
      if (this._pending) merged.set(this._pending, 0);
      merged.set(new Uint8Array(raw), prevLen);
      this._pending = merged;
      const usable = this._pending.length & ~1; // 对齐到偶数(每采样 2 字节)
      if (usable === 0) return;
      const int16 = new Int16Array(this._pending.buffer, 0, usable / 2);
      this._pending = this._pending.slice(usable);

      // 每块都把调度起点夹到「不低于当前+余量」:只有首块 clamp 的话,若后端某段空窗后连送块,
      // _nextTime 落后于 current 会"追播"过去,导致攒了几块突然一起播。
      this._nextTime = Math.max(this._nextTime, ctx.currentTime + 0.15);
      const f32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768;
      const buf = ctx.createBuffer(1, f32.length, this._ttsSampleRate);
      buf.copyToChannel(f32, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this._out);
      this._activeSources.add(src);
      src.onended = () => {
        this._activeSources.delete(src);
        if (this._activeSources.size === 0 && gen === this._playGen) this._setPlaying(false);
      };
      src.start(this._nextTime);
      this._pcmCount++;
      this._nextTime += buf.duration;
    }
  }

  // ============ VoiceAgent:三路问答统一入口 ============
  const MIN_DURATION = 400; // 按住说话最短时长(ms),太短不发

  // 打断词判定完全在后端(唤醒链监听采集→ASR→匹配暂停词→发 interrupt)，前端只执行停止，不做判断。

  class VoiceAgent {
    constructor(opts = {}) {
      this.baseUrl = String(opts.baseUrl || '').replace(/\/+$/, ''); // 跨域部署:后端地址(如 http://host:port)

      this._on = {
        userText: opts.onUserText,
        reply: opts.onReply,
        wake: opts.onWake,
        sleep: opts.onSleep,
        interrupt: opts.onInterrupt,
        stateChange: opts.onStateChange,
        error: opts.onError,
        audioStream: opts.onAudioStream,
      };

      this._tts = new TtsPlayer(this.baseUrl);
      this._tts.onError = (msg) => this._emit('error', 'TTS 失败:' + msg);
      this._tts.onStateChange = () => this._refreshState();
      this._tts.onAudioStream = (stream) => this._emit('audioStream', stream);

      // 状态:派生于 _recording/_tts.playing/_wakeOn/_armed/_ctxRunning,见 _refreshState
      this._state = 'idle';
      this._reqSeq = 0;        // 请求竞态:只让最后一次提问生效,丢弃晚到的旧响应
      this._recording = false;

      // 唤醒监听相关
      this._wakeOn = false;    // 采集常开
      this._armed = false;     // 是否在唤醒窗口内
      this._ctxRunning = false;// 采集 AudioContext 是否 running(加载时 suspended)
      this._wakeWs = null;
      this._micStream = null;
      this._wakeCtx = null;
      this._srcNode = null;
      this._procNode = null;
      this._gestureHandler = null;

      // 按住说话相关
      this._mediaRecorder = null;
      this._recStream = null;
      this._chunks = [];
      this._recStartTime = 0;
      this._shouldSend = false;

      if (opts.autoWake) {
        // 延迟到构造完成后:startWake 会同步触发 onStateChange('starting'),
        // 若此刻触发,回调里可能访问尚未完成赋值的 agent 变量(TDZ),抛 ReferenceError。
        setTimeout(() => {
          this.startWake().catch((e) => {
            this._emit('error', '无法监听:' + e.message);
            this._refreshState();
          });
        }, 0);
      }
    }

    get wakeActive() { return this._wakeOn; }

    // TTS 播放输出流(创建后即稳定存在;无播放时音频静音,供 Live2D 口型同步等消费)
    get audioStream() { return this._tts.audioStream; }

    // 接口地址:传了 baseUrl 就指向后端(HTTP 拼前缀,WS 把 http→ws);
    // 没传则用同源相对路径(默认同源部署)。
    _apiUrl(path) { return this.baseUrl + path; }
    _wsUrl(path) {
      if (this.baseUrl) return this.baseUrl.replace(/^http/, 'ws') + path;
      return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + path;
    }

    _emit(name, ...args) {
      const fn = this._on[name];
      if (typeof fn === 'function') fn(...args);
    }

    _setState(s) {
      if (s === this._state) return;
      this._state = s;
      this._emit('stateChange', s);
    }

    // 状态派生:recording > speaking > 唤醒窗口/监听 > idle。
    // 采集 ctx 未 resume 时监听态显示 waiting-activation,提示首次手势激活。
    _refreshState() {
      let s;
      if (this._recording) s = 'recording';
      else if (this._tts.playing) s = 'speaking';
      else if (this._wakeOn) s = this._armed ? 'wake-active' : (this._ctxRunning ? 'listening' : 'waiting-activation');
      else s = 'idle';
      this._setState(s);
    }

    // 浏览器 autoplay 限制:加载时 AudioContext 挂起,onaudioprocess 不触发。
    // 挂一次性全局手势,首次交互 resume 采集 ctx,期间提示「点击页面任意处以开始监听」。
    _armGestureResume(ctx) {
      if (this._gestureHandler) return;
      const handler = () => {
        this._disarmGesture();
        ctx.resume()
          .then(() => { this._ctxRunning = true; this._refreshState(); })
          .catch(() => {});
      };
      this._gestureHandler = handler;
      ['pointerdown', 'touchstart', 'keydown'].forEach((ev) =>
        document.addEventListener(ev, handler, { passive: true }));
    }

    _disarmGesture() {
      if (!this._gestureHandler) return;
      ['pointerdown', 'touchstart', 'keydown'].forEach((ev) =>
        document.removeEventListener(ev, this._gestureHandler));
      this._gestureHandler = null;
    }

    // ============ ① 唤醒监听(/api/wake WS) ============
    async startWake() {
      if (this._wakeOn) return;
      this._setState('starting');
      // echoCancellation 消扬声器回声:外放时回答声不会再被 VAD 误判成"用户开口"而自打断
      // (打断要求采集常开,开 AEC 是防止外放自打断的关键)。noiseSuppression/autoGainControl 顺带降噪。
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      this._micStream = stream;
      // 采集固定 16k,与后端 VAD/ASR 一致(浏览器自动重采样)。
      const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      if (Math.abs(ctx.sampleRate - 16000) > 1) {
        stream.getTracks().forEach((t) => t.stop());
        throw new Error('浏览器不支持 16k 采样率(实际 ' + ctx.sampleRate + 'Hz),无法做唤醒检测');
      }
      this._wakeCtx = ctx;
      this._ctxRunning = ctx.state === 'running';

      const wsUrl = this._wsUrl('/api/wake');
      const ws = new WebSocket(wsUrl);
      this._wakeWs = ws;

      const srcNode = ctx.createMediaStreamSource(stream);
      const procNode = ctx.createScriptProcessor(4096, 1, 1); // 每块 256ms(16k)
      srcNode.connect(procNode);
      // 采集链路不能直通扬声器:麦克风声音会被实时外放,助手回答一出声就采回去,
      // 形成回声/啸叫。接 0 增益节点让 onaudioprocess 正常触发但不外放。
      const muteGain = ctx.createGain();
      muteGain.gain.value = 0;
      procNode.connect(muteGain);
      muteGain.connect(ctx.destination);
      this._srcNode = srcNode;
      this._procNode = procNode;

      procNode.onaudioprocess = (e) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          const f = e.inputBuffer.getChannelData(0);
          const i16 = new Int16Array(f.length);
          for (let i = 0; i < f.length; i++) i16[i] = Math.max(-1, Math.min(1, f[i])) * 32767;
          ws.send(i16.buffer);
        }
      };

      ws.onmessage = (e) => this._onWakeMessage(JSON.parse(e.data));
      ws.onerror = () => { if (this._wakeOn) this.stopWake(); this._emit('error', '唤醒连接异常'); };
      ws.onclose = () => { if (this._wakeOn) this.stopWake(); };

      this._wakeOn = true;
      if (!this._ctxRunning) this._armGestureResume(ctx);
      this._refreshState();
    }

    stopWake() {
      if (!this._wakeOn) return;
      this._wakeOn = false;
      this._armed = false;
      this._disarmGesture();
      if (this._procNode) { this._procNode.onaudioprocess = null; this._procNode.disconnect(); }
      if (this._srcNode) this._srcNode.disconnect();
      if (this._wakeCtx) { this._wakeCtx.close().catch(() => {}); }
      if (this._wakeWs) this._wakeWs.close();
      if (this._micStream) this._micStream.getTracks().forEach((t) => t.stop());
      this._wakeWs = null; this._wakeCtx = null; this._srcNode = null; this._procNode = null; this._micStream = null;
      this._ctxRunning = false;
      this._refreshState();
    }

    // 手动唤醒:免唤醒词直接进入唤醒窗口(后端 /api/wake 收到 wake_manual 后武装检测器)。
    // 用于唤醒词一直检测不到时兜底:点一下=说了唤醒词,窗口内直接说话即可回答。
    // 返回是否已发送(唤醒 WS 未连接时返回 false,需先 startWake)。
    wakeManual() {
      const ws = this._wakeWs;
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify({ type: 'wake_manual' }));
      return true;
    }

    _onWakeMessage(msg) {
      switch (msg.type) {
        case 'answer': // 唤醒自动回答:只说唤醒词时 replyText=固定问候(走 /api/tts 全篇);带问题则走 /api/chat_stream 流式
          this._armed = true;
          this._tts.onDone = null;
          if (msg.replyText) {
            if (msg.userText) this._emit('userText', msg.userText);
            this._emit('reply', msg.replyText);
            this._tts.play(msg.replyText);
          } else {
            this._streamReply(msg.userText); // 带问题:流式问答,完整回复经 onDone → onReply 回
          }
          break;
        case 'interrupt': // 后端识别到打断词(如"别说了"):停止正在播的回答;没在播则忽略,不误报 onInterrupt
          if (this._tts.playing) {
            this._tts.stop();
            this._emit('interrupt');
          }
          break;
        case 'wake': // 命中唤醒词,进入唤醒窗口;timeoutSeconds=窗口总秒数
          this._armed = true;
          this._emit('wake', msg.word, msg.timeoutSeconds);
          break;
        case 'sleep': // 唤醒窗口超时,已休眠;idleSeconds=实际静默秒数
          this._armed = false;
          this._emit('sleep', msg.idleSeconds);
          break;
      }
      this._refreshState();
    }

    // ============ ② 按住说话(POST /api/chat, multipart) ============
    _pickMimeType() {
      const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
      for (const c of candidates) if (MediaRecorder.isTypeSupported(c)) return c;
      return '';
    }

    async startRecording() {
      this._tts.stop(); // 开口即打断正在播的回答
      // 按住说话同样开回声消除/降噪;MediaRecorder 按设备默认采样率录(opus 内部 48k),不设 sampleRate
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this._recStream = stream;
      this._chunks = [];
      const mimeType = this._pickMimeType();
      const mr = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      this._mediaRecorder = mr;
      mr.ondataavailable = (e) => { if (e.data && e.data.size > 0) this._chunks.push(e.data); };
      mr.onstop = () => { this._sendAudio(); };
      this._recStartTime = Date.now();
      this._shouldSend = false;
      mr.start();
      this._recording = true;
      this._refreshState();
    }

    // 松开发送。返回 Promise:resolve 本次问答结果 {replyText,userText},或 null(录音太短/为空)。
    stopRecording() {
      if (!this._recording || !this._mediaRecorder) return Promise.resolve(null);
      this._recording = false;
      this._refreshState();
      const mr = this._mediaRecorder;
      const stream = this._recStream;
      const short = Date.now() - this._recStartTime < MIN_DURATION;
      this._shouldSend = !short;
      if (short) this._chunks = [];
      return new Promise((resolve) => {
        mr.onstop = () => resolve(this._sendAudio());
        mr.stop();
        if (stream) stream.getTracks().forEach((t) => t.stop());
      });
    }

    async _sendAudio() {
      if (!this._shouldSend) return null;
      const seq = ++this._reqSeq; // 打断式播放:本次为最新请求
      const blob = new Blob(this._chunks, { type: this._mediaRecorder.mimeType || 'audio/webm' });
      if (blob.size < 1000) { this._emit('error', '录音内容为空,请重试'); return null; }
      const form = new FormData();
      form.append('audio', blob, 'recording');
      try {
        // 语音两跳第一跳:后端只做转码+VAD+ASR 回 userText(不调 LLM),由前端再连 /api/chat_stream 流式问答。
        const res = await fetch(this._apiUrl('/api/chat'), { method: 'POST', body: form });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
        if (seq !== this._reqSeq) return data; // 已有更新的提问,丢弃旧响应
        if (data.userText) this._streamReply(data.userText); // 识别文本交给 /api/chat_stream 流式问答
        return data;
      } catch (err) {
        if (seq === this._reqSeq) this._emit('error', '出错了:' + err.message);
        throw err;
      } finally {
        this._refreshState();
      }
    }

    // ============ ③ 文字问答(流式:改走 /api/chat_stream) ============
    // 流式问答:连 /api/chat_stream,由后端一条龙做 LLM 增量→逐句 TTS→顺序推 PCM。
    // 完整回复经 onDone(replyText) → onReply 回调;打断直接 _tts.stop() 关连接,服务端中止。
    _streamReply(text) {
      const q = String(text || '').trim();
      if (!q) return;
      const seq = ++this._reqSeq; // 抢占:只让最后一次提问生效
      this._tts.onReplyDelta = null;
      this._tts.onDone = (replyText) => {
        if (seq !== this._reqSeq) return;
        if (replyText) this._emit('reply', replyText);
      };
      const url = this._wsUrl('/api/chat_stream');
      this._tts.playStream(url, { type: 'chat', text: q }).catch((e) => {
        if (seq === this._reqSeq) this._emit('error', '出错了:' + e.message);
      });
      this._emit('userText', q);
      this._refreshState();
    }

    async askText(text) {
      const t = String(text || '').trim();
      if (!t) return null;
      this._streamReply(t);
    }

    // 手动打断播放(保底):停止当前回答;在播时触发 onInterrupt,与语音打断行为一致。
    // 语音/打断词识别失效时点它兜底。
    stopPlay() {
      const was = this._tts.playing;
      this._tts.stop();
      if (was) this._emit('interrupt');
      this._refreshState();
    }
  }

  global.VoiceAgent = VoiceAgent;
})(window);
