'use strict';
// VoicePet:可替换精灵图集数字人。保持无构建、无依赖的 IIFE 接入方式。
// 标准形象是 8×8 透明图集；旧图仍可通过 pet.json 的 safeCrop 修掉越格残影。
(function (global) {
  const LOG_LEVELS = { off: 0, warn: 1, info: 1, frame: 2 };
  const FRAME_DELTA_CAP = 100;
  const MOUTH_ATTACK_MS = 42;
  const MOUTH_RELEASE_MS = 105;
  const MOUTH_HOLD_MS = 38;
  const SILENCE_GATE = 0.012;

  class VoicePet {
    constructor(opts = {}) {
      this.el = opts.el;
      this.agent = opts.agent || null;
      this.size = opts.size || 120;
      this.petName = opts.pet || null;
      this.baseUrl = String(opts.baseUrl || '').replace(/\/+$/, '');
      this.logLevel = this._resolveLogLevel(opts.logLevel);
      this._pet = null; this._list = [];
      this._state = 'idle'; this._baseState = 'idle'; this._agentState = 'idle';
      this._curDef = null; this._transient = null; this._pendingReview = false;
      this._frameIdx = 0; this._frameTime = 0; this._lastTick = null;
      this._audioCtx = null; this._analyser = null; this._analyserSrc = null; this._lv = null; this._pcmLevel = null;
      this._env = 0; this._lastLevel = 0; this._mouthCandidate = 0; this._mouthCandidateAt = 0;
      this._raf = null; this._canvas = null; this._ctx = null; this._select = null; this._tip = null;
      this._subscriptions = []; this._lastFrameLog = 0; this._warned = new Set();
      this._initialized = false; this._destroyed = false;
    }

    _resolveLogLevel(value) {
      let name = value;
      if (name == null || name === '') {
        try { name = new URLSearchParams(location.search).get('petlog'); } catch (_) {}
      }
      const level = LOG_LEVELS[String(name == null ? '' : name).trim().toLowerCase()];
      return level == null ? LOG_LEVELS.info : level;
    }
    _logLevelName() { return this.logLevel >= LOG_LEVELS.frame ? 'frame' : (this.logLevel >= LOG_LEVELS.info ? 'info' : 'off'); }
    setLogLevel(value) { this.logLevel = this._resolveLogLevel(value); this._log('info', `日志级别 → ${this._logLevelName()}`); return this; }
    _log(level, message) {
      if (this.logLevel < (LOG_LEVELS[level] || LOG_LEVELS.info)) return;
      const line = `[VoicePet] ${message}`;
      if (level === 'warn') console.warn(line); else console.log(line);
    }
    _warnOnce(key, message) {
      if (this._warned.has(key)) return;
      this._warned.add(key); this._log('warn', message);
    }

    async init() {
      if (this._initialized) return this;
      if (!this.el) throw new Error('缺少数字人容器 el');
      this._destroyed = false;
      this._list = await this._listPets();
      const queryName = (() => { try { return new URLSearchParams(location.search).get('pet'); } catch (_) { return null; } })();
      const name = this.petName || queryName || (this._list[0] && this._list[0].name) || 'demo';
      this._pet = await this._loadPet(this._findEntry(name));
      this._buildUI();
      this._validateAsset();
      if (!this.agent) this.agent = new (global.VoiceAgent || function () { throw new Error('需先引入 voice-agent.js'); })();
      this._subscribe();
      this._baseState = this._map('idle');
      this._activate(this._baseState, '初始化完成');
      this._initialized = true;
      global.__voicePet = this;
      this._raf = requestAnimationFrame((t) => this._frame(t));
      const grid = this._gridSize();
      this._log('info', `形象「${this._pet.name}」已加载:${this._pet.img.naturalWidth}×${this._pet.img.naturalHeight},网格 ${grid.cols}×${grid.rows},日志=${this._logLevelName()}`);
      return this;
    }

    async _listPets() {
      try {
        const res = await fetch(`${this.baseUrl}/api/pets`);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        return Array.isArray(data.pets) ? data.pets : [];
      } catch (error) {
        this._log('warn', `形象列表加载失败:${error.message || error};尝试默认 demo`);
        return [];
      }
    }
    _findEntry(name) { return this._list.find((item) => item.name === name) || { name, sprite: `${name}.png`, meta: null }; }
    _spriteUrl(sprite) { return this.baseUrl + '/pets/' + sprite; }
    _loadImage(sprite) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('形象图集加载失败:' + sprite));
        img.src = this._spriteUrl(sprite);
      });
    }
    async _loadPet(entry) {
      const sprite = entry.sprite || `${entry.name}.png`;
      return { name: entry.name, sprite, meta: entry.meta || null, img: await this._loadImage(sprite) };
    }

    _meta() { return (this._pet && this._pet.meta) || {}; }
    _gridSize() {
      const grid = this._meta().grid || {};
      return {
        cols: Number.isInteger(grid.cols) && grid.cols > 0 ? grid.cols : 8,
        rows: Number.isInteger(grid.rows) && grid.rows > 0 ? grid.rows : 8,
      };
    }
    _gain() { const gain = this._meta().levelGain; return typeof gain === 'number' && gain > 0 ? gain : 8; }
    _safeCrop() {
      const crop = this._meta().safeCrop;
      if (typeof crop === 'number' && crop >= 0) return { top: crop, right: crop, bottom: crop, left: crop };
      if (!crop || typeof crop !== 'object') return { top: 0, right: 0, bottom: 0, left: 0 };
      const side = (name) => Number.isFinite(crop[name]) && crop[name] >= 0 ? crop[name] : 0;
      return { top: side('top'), right: side('right'), bottom: side('bottom'), left: side('left') };
    }
    _map(agentState) { return (this._meta().mapping || {})[agentState] || 'idle'; }

    _stateDef(name) {
      const meta = this._meta();
      const states = meta.states || {};
      const raw = states[name];
      const grid = this._gridSize();
      if (!raw) this._warnOnce('missing:' + name, `状态「${name}」未定义,已回退到待机帧`);
      const source = raw || states.idle || { row: 0, from: 0, to: grid.cols - 1, loop: true, fps: 8 };
      const clampInt = (value, min, max, fallback) => Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
      const row = clampInt(source.row, 0, grid.rows - 1, 0);
      const from = clampInt(source.from, 0, grid.cols - 1, 0);
      const to = clampInt(source.to, from, grid.cols - 1, Math.max(from, grid.cols - 1));
      const fps = typeof source.fps === 'number' && source.fps > 0 ? source.fps
        : (typeof meta.defaultFps === 'number' && meta.defaultFps > 0 ? meta.defaultFps : 8);
      if (raw && (row !== source.row || from !== source.from || to !== source.to)) {
        this._warnOnce('range:' + name, `状态「${name}」帧范围越界,已夹到 ${row}:${from}..${to}`);
      }
      const count = to - from + 1;
      const durations = Array.isArray(source.durations)
        ? Array.from({ length: count }, (_, i) => Number(source.durations[i]) > 0 ? Number(source.durations[i]) : 1000 / fps)
        : null;
      return { row, from, to, loop: source.loop !== false, fps, durations, lift: Number(source.lift) >= 0 ? Number(source.lift) : 0 };
    }

    _buildUI() {
      this.el.classList.add('voicepet');
      this.el.style.width = this.size + 'px';
      if (this._list.length > 1) {
        const select = document.createElement('select');
        select.className = 'voicepet-sel';
        this._list.forEach((item) => {
          const option = document.createElement('option');
          option.value = item.name; option.textContent = (item.meta && item.meta.name) || item.name;
          option.selected = item.name === this._pet.name; select.appendChild(option);
        });
        select.addEventListener('change', () => this._swap(select.value));
        this._select = select; this.el.appendChild(select);
      }
      const canvas = document.createElement('canvas');
      const dpr = global.devicePixelRatio || 1;
      const side = this.size - (this._select ? 24 : 0);
      canvas.style.cssText = `width:${side}px;height:${side}px;background:transparent;cursor:pointer`;
      canvas.width = Math.round(side * dpr); canvas.height = Math.round(side * dpr);
      canvas.addEventListener('click', () => { if (!this._isConversationBusy()) this._playTransient('jump', '点击数字人'); });
      this._canvas = canvas; this._ctx = canvas.getContext('2d'); this._ctx.imageSmoothingEnabled = false;
      this.el.style.background = 'transparent'; this.el.style.padding = '0'; this.el.style.border = 'none'; this.el.style.boxShadow = 'none';
      this.el.appendChild(canvas);
    }
    _showTip(message, error) {
      if (this._tip) this._tip.remove();
      const tip = document.createElement('div');
      tip.className = 'voicepet-tip'; tip.style.cssText = `font-size:.7rem;color:${error ? '#c0392b' : '#b7791f'};margin-top:.2rem`;
      tip.textContent = message; this._tip = tip; this.el.appendChild(tip);
    }
    _validateAsset() {
      const img = this._pet.img; const grid = this._gridSize(); const width = img.naturalWidth; const height = img.naturalHeight;
      if (width !== height || width % grid.cols || height % grid.rows) {
        this._showTip(`旧图集 ${width}×${height} 不能被 ${grid.cols}×${grid.rows} 整除;已兼容切帧,建议按新标准重新生成。`, false);
      } else if (this._tip) { this._tip.remove(); this._tip = null; }
    }
    async _swap(name) {
      const previous = this._pet;
      if (this._select) this._select.disabled = true;
      try {
        const candidate = await this._loadPet(this._findEntry(name));
        if (this._destroyed) return false;
        this._pet = candidate; this._warned.clear(); this._validateAsset();
        this._baseState = this._map(this._agentState); this._transient = null;
        this._activate(this._baseState, '切换形象', true);
        this._log('info', `切换形象 →「${candidate.name}」(${candidate.sprite})`);
        return true;
      } catch (error) {
        this._pet = previous;
        if (this._select) this._select.value = previous.name;
        this._showTip(error.message || String(error), true); this._log('warn', error.message || String(error));
        return false;
      } finally { if (this._select) this._select.disabled = false; }
    }

    _subscribe() {
      const listen = (name, fn) => { this.agent.on(name, fn); this._subscriptions.push({ name, fn }); };
      listen('stateChange', (state) => this._handleAgentState(state));
      listen('wake', () => { if (!this._isConversationBusy()) this._playTransient('wave', '唤醒命中'); });
      listen('reply', () => { this._pendingReview = true; });
      listen('error', (error) => { this._pendingReview = false; this._playTransient('failed', `错误:${(error && error.message) || error}`, true); });
      listen('interrupt', () => { this._pendingReview = false; this._playTransient('failed', '回答被打断', true); });
      listen('audioStream', (stream) => this._initAudio(stream));
      listen('audioLevel', (level) => { this._pcmLevel = Math.max(0, Math.min(1, Number(level) || 0)); });
    }
    _handleAgentState(state) {
      const wasSpeaking = this._agentState === 'speaking';
      this._agentState = state; this._baseState = this._map(state);
      if (state === 'speaking' || state === 'recording') {
        this._transient = null; this._activate(this._baseState, `agent.stateChange(${state})`, true); return;
      }
      if (wasSpeaking && this._pendingReview) {
        this._pendingReview = false; this._playTransient('review', '声音播放结束后轻点头', true); return;
      }
      if (!this._transient || this._state === this._map('speaking') || this._state === this._map('recording')) {
        this._activate(this._baseState, `agent.stateChange(${state})`);
      }
    }
    _isConversationBusy() { return this._agentState === 'speaking' || this._agentState === 'recording'; }
    setState(name, reason) {
      const def = this._stateDef(name);
      if (def.loop) {
        this._baseState = name;
        if (!this._transient && !this._isConversationBusy()) this._activate(name, reason || 'setState');
      } else if (!this._isConversationBusy()) this._playTransient(name, reason || 'setState');
      return this;
    }
    _activate(name, reason, restart) {
      if (!restart && this._state === name && this._curDef && this._curDef.loop) return;
      const previous = this._curDef ? this._state : '(初始)';
      this._state = name; this._curDef = this._stateDef(name); this._frameIdx = 0; this._frameTime = 0; this._lastTick = null;
      if (name !== this._map('speaking')) { this._env = 0; this._mouthCandidate = 0; this._mouthCandidateAt = 0; }
      this._log('info', `状态 ${previous} → ${name} ← ${reason || '内部切换'}`);
    }
    _playTransient(name, reason, force) {
      if (!force && this._isConversationBusy()) return false;
      const def = this._stateDef(name);
      if (def.loop) { this._baseState = name; this._transient = null; } else this._transient = name;
      this._activate(name, reason, true); return true;
    }
    _finishTransient(name) {
      if (this._transient === name) this._transient = null;
      this._activate(this._baseState, `「${name}」播放完成`, true);
    }

    _pickAnalyser() {
      const analyser = this.agent && this.agent.analyser;
      if (analyser && analyser !== this._analyser) {
        this._analyser = analyser; this._analyserSrc = 'sdk'; this._lv = new Uint8Array(analyser.fftSize);
        this._log('info', `口型音频源=SDK analyser,增益=${this._gain()}`);
      }
      return this._analyser;
    }
    _initAudio(stream) {
      if (this._pickAnalyser() || this._analyser || !stream) return;
      try {
        this._audioCtx = new (global.AudioContext || global.webkitAudioContext)();
        this._audioCtx.resume().catch(() => {});
        const analyser = this._audioCtx.createAnalyser(); const sink = this._audioCtx.createGain();
        analyser.fftSize = 256; sink.gain.value = 0;
        this._audioCtx.createMediaStreamSource(stream).connect(analyser); analyser.connect(sink); sink.connect(this._audioCtx.destination);
        this._analyser = analyser; this._analyserSrc = 'stream'; this._lv = new Uint8Array(analyser.fftSize);
      } catch (error) { this._warnOnce('audio', `口型分析器初始化失败:${error.message || error}`); }
    }
    _level() {
      if (this._pcmLevel != null) return Math.min(1, Math.max(0, this._pcmLevel - SILENCE_GATE) * this._gain());
      const analyser = this._pickAnalyser();
      if (!analyser || !this._lv) return 0;
      analyser.getByteTimeDomainData(this._lv);
      let sum = 0;
      for (let i = 0; i < this._lv.length; i++) { const value = (this._lv[i] - 128) / 128; sum += value * value; }
      const rms = Math.sqrt(sum / this._lv.length);
      return Math.min(1, Math.max(0, rms - SILENCE_GATE) * this._gain());
    }
    _isSpeakingVisual() { return this._agentState === 'speaking' && this._state === this._map('speaking'); }
    _updateMouth(delta, now, count) {
      this._lastLevel = this._level();
      const time = this._lastLevel > this._env ? MOUTH_ATTACK_MS : MOUTH_RELEASE_MS;
      const alpha = delta > 0 ? 1 - Math.exp(-delta / time) : 0;
      this._env += (this._lastLevel - this._env) * alpha;
      // 连续静音时直接吸附到闭口，避免句间停顿仍挂着半张嘴。
      if (this._lastLevel === 0 && this._env < 0.12) this._env = 0;
      const candidate = Math.max(0, Math.min(count - 1, Math.round(Math.pow(this._env, 0.72) * (count - 1))));
      if (candidate !== this._mouthCandidate) { this._mouthCandidate = candidate; this._mouthCandidateAt = now; }
      // 大幅音量变化立即响应；只对相邻档位做短时防抖，兼顾“看得见张嘴”和稳定性。
      if (candidate === 0 || Math.abs(candidate - this._frameIdx) >= 2 || now - this._mouthCandidateAt >= MOUTH_HOLD_MS) {
        this._frameIdx = candidate;
      }
    }
    _frameDuration(def, index) { return (def.durations && def.durations[index]) || 1000 / def.fps; }
    _step(delta, now) {
      let def = this._curDef || this._stateDef(this._baseState);
      const count = def.to - def.from + 1;
      if (this._isSpeakingVisual()) { this._updateMouth(delta, now, count); return; }
      this._env = Math.max(0, this._env - delta / MOUTH_RELEASE_MS);
      this._frameTime += delta;
      let guard = count + 1;
      while (guard-- > 0 && this._frameTime >= this._frameDuration(def, this._frameIdx)) {
        this._frameTime -= this._frameDuration(def, this._frameIdx); this._frameIdx++;
        if (this._frameIdx < count) continue;
        if (def.loop) this._frameIdx = 0;
        else { const completed = this._state; this._frameIdx = count - 1; this._finishTransient(completed); def = this._curDef; break; }
      }
    }

    _draw(now) {
      if (!this._pet || !this._pet.img || !this._ctx) return;
      const def = this._curDef || this._stateDef(this._baseState); const grid = this._gridSize();
      const sourceFrame = def.from + this._frameIdx; const img = this._pet.img;
      const x0 = Math.round(sourceFrame * img.naturalWidth / grid.cols); const x1 = Math.round((sourceFrame + 1) * img.naturalWidth / grid.cols);
      const y0 = Math.round(def.row * img.naturalHeight / grid.rows); const y1 = Math.round((def.row + 1) * img.naturalHeight / grid.rows);
      const cellW = x1 - x0; const cellH = y1 - y0; const crop = this._safeCrop();
      const left = Math.min(crop.left, cellW / 3); const right = Math.min(crop.right, cellW / 3);
      const top = Math.min(crop.top, cellH / 3); const bottom = Math.min(crop.bottom, cellH / 3);
      const canvasW = this._canvas.width; const canvasH = this._canvas.height;
      const dx = left / cellW * canvasW; const dy = top / cellH * canvasH;
      const dw = (cellW - left - right) / cellW * canvasW; const dh = (cellH - top - bottom) / cellH * canvasH;
      const ctx = this._ctx; ctx.clearRect(0, 0, canvasW, canvasH); ctx.imageSmoothingEnabled = false;
      const lift = this._state === 'jump' ? def.lift : 0;
      if (lift > 0) {
        const count = def.to - def.from + 1;
        const progress = Math.min(1, (this._frameIdx + this._frameTime / this._frameDuration(def, this._frameIdx)) / count);
        ctx.save(); ctx.translate(0, -canvasH * lift * Math.sin(progress * Math.PI));
      }
      ctx.drawImage(img, x0 + left, y0 + top, cellW - left - right, cellH - top - bottom, dx, dy, dw, dh);
      if (lift > 0) ctx.restore();
      if (this.logLevel >= LOG_LEVELS.frame && now - this._lastFrameLog >= 100) {
        this._lastFrameLog = now;
        this._log('frame', `画帧:${this._state} row=${def.row} col=${sourceFrame},level=${this._lastLevel.toFixed(2)},env=${this._env.toFixed(2)}`);
      }
    }
    _frame(now) {
      if (this._destroyed) return;
      const delta = this._lastTick == null ? 0 : Math.min(FRAME_DELTA_CAP, Math.max(0, now - this._lastTick));
      this._lastTick = now; this._step(delta, now); this._draw(now);
      this._raf = requestAnimationFrame((time) => this._frame(time));
    }

    destroy() {
      if (this._destroyed) return;
      this._destroyed = true; this._initialized = false;
      if (this._raf != null) cancelAnimationFrame(this._raf);
      this._raf = null;
      this._subscriptions.forEach(({ name, fn }) => { if (this.agent && typeof this.agent.off === 'function') this.agent.off(name, fn); });
      this._subscriptions = [];
      if (this._audioCtx && this._audioCtx.close) this._audioCtx.close().catch(() => {});
      this._audioCtx = null; this._analyser = null; this._lv = null; this._pcmLevel = null;
      if (this.el) this.el.innerHTML = '';
      if (global.__voicePet === this) delete global.__voicePet;
    }
  }

  global.VoicePet = VoicePet;
})(window);
