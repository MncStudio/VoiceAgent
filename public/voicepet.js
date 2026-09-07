'use strict';
// VoicePet:桌面宠物渲染器(精灵图集 + 状态机)。只支持【网格模式】:
// 形象图必须是"均匀的 N×M 网格"(默认 8×8),每格同一角色的一个动作帧;渲染器按图片尺寸 ÷ 格子数 均分切帧,
// 不要求固定像素(如 1536×1664)、不做单图模式。若图其实不是网格,会切成一块块,请用正确规格的图。
//
// 用法:
//   const pet = new VoicePet({ el, agent, pet?, size? });
//     el   : 容器(内部放 canvas + 可选的宠物切换下拉)
//     agent: 已 mock 的 VoiceAgent 实例(可选;不传则自行 new 一个)
//     pet  : 指定宠物名,缺省用 ?pet= 或后端列表第一个
//     size : 画布 CSS 尺寸,默认 120
// 依赖:window.VoiceAgent(public/voice-agent.js)。经 agent.on('stateChange'|'wake'|'reply'|'error'|'interrupt'|'audioStream') 驱动。
(function (global) {
  class VoicePet {
    constructor(opts = {}) {
      this.el = opts.el;
      this.agent = opts.agent || null;
      this.size = opts.size || 120;
      this.petName = opts.pet || null;
      this.baseUrl = String(opts.baseUrl || '').replace(/\/+$/, '');
      this._pet = null;          // {meta,img}
      this._state = 'idle';
      this._frameIdx = 0;
      this._frameTime = 0;
      this._curDef = null;
      this._audioCtx = null; this._analyser = null; this._lv = null; this._env = 0;
      this._raf = null;
      this._canvas = null; this._ctx = null;
    }

    async init() {
      const list = await this._listPets();
      this._list = list;
      const name = this.petName || new URLSearchParams(location.search).get('pet') || (list[0] && list[0].name) || 'demo';
      const entry = list.find((p) => p.name === name) || { name, sprite: `${name}.png` };
      this._pet = { meta: entry.meta || null, sprite: `${name}.png`, name };
      this._buildUI(list);
      const img = new Image();
      img.src = this._spriteUrl(entry.sprite);
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('宠物图集加载失败:' + entry.sprite)); });
      this._pet.img = img;
      this._warnIfNotSquare();
      if (!this.agent) this.agent = new (global.VoiceAgent || function () { throw new Error('需先引入 voice-agent.js'); })();
      this._subscribe();
      this.setState(this._map('idle'));
      this._raf = requestAnimationFrame((t) => this._frame(t));
      return this;
    }

    // 自适应:按图片尺寸 ÷ 格子数 切帧。仅要求"正方形"(正方 → 每格就是正方形);非正方给个提示但不阻断。
    _warnIfNotSquare() {
      const img = this._pet.img, w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) return;
      if (Math.abs(w - h) / Math.max(w, h) > 0.02) {
        const tip = document.createElement('div');
        tip.style.cssText = 'font-size:.7rem;color:#b7791f;margin-top:.2rem';
        tip.textContent = `建议正方形图(当前 ${w}×${h}),非正方会导致格子略扁;已自适应切格不影响使用。`;
        this.el.appendChild(tip);
      }
    }

    async _listPets() {
      try { const res = await fetch(`${this.baseUrl}/api/pets`); const d = await res.json(); return Array.isArray(d.pets) ? d.pets : []; }
      catch { return []; }
    }
    _spriteUrl(sp) { return this.baseUrl + '/pets/' + sp; }
    _frameSize() { return ((this._pet.meta && this._pet.meta.frame) || { w: 128, h: 128 }); } // 默认每格 128×128 → 整图 1024×1024(GPT 等模型稳定可出的方图)
    _gridSize() { return ((this._pet.meta && this._pet.meta.grid) || { cols: 8, rows: 8 }); }
    _metaDefault() {
      const m = this._pet.meta || {};
      return { states: m.states || {}, mapping: m.mapping || {}, grid: m.grid || { cols: 8, rows: 8 } };
    }

    _buildUI(list) {
      this.el.classList.add('voicepet');
      this.el.style.width = this.size + 'px';
      if (list.length > 1) {
        const sel = document.createElement('select');
        sel.className = 'voicepet-sel';
        list.forEach((p) => {
          const o = document.createElement('option');
          const label = (p.meta && p.meta.name) || p.name;
          o.value = p.name; o.textContent = label;
          if (p.name === this._pet.name) o.selected = true;
          sel.appendChild(o);
        });
        sel.addEventListener('change', async () => this._swap(sel.value));
        this.el.appendChild(sel);
      }
      this._canvas = document.createElement('canvas');
      const dpr = window.devicePixelRatio || 1;
      const s = this.size - (list.length > 1 ? 24 : 0);
      this._canvas.style.width = s + 'px';
      this._canvas.style.height = s + 'px';
      this._canvas.width = Math.round(s * dpr);
      this._canvas.height = Math.round(s * dpr);
      this._ctx = this._canvas.getContext('2d');
      this._ctx.imageSmoothingEnabled = false;
      this.el.appendChild(this._canvas);
    }

    async _swap(name) {
      const entry = (this._list || []).find((p) => p.name === name) || { name, sprite: `${name}.png` };
      const img = new Image();
      img.src = this._spriteUrl(entry.sprite);
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('加载失败')); });
      this._pet = { img, meta: entry.meta || null, sprite: `${name}.png`, name };
      this._warnIfNotSquare();
      this.setState('idle');
    }

    _map(state) { const m = this._metaDefault().mapping; return m[state] || 'idle'; }

    setState(name) {
      const states = this._metaDefault().states;
      const def = states[name] || { row: 0, from: 0, to: 5, loop: true, fps: 8 };
      if (this._state === name && this._curDef && this._curDef.loop) return;
      this._state = name; this._curDef = def; this._frameIdx = 0; this._frameTime = 0;
    }

    _subscribe() {
      const a = this.agent;
      a.on('stateChange', (s) => this.setState(this._map(s)));
      a.on('wake', () => this.setState('wave'));
      a.on('reply', () => this.setState('review'));
      a.on('error', () => this.setState('failed'));
      a.on('interrupt', () => this.setState('failed'));
      a.on('audioStream', (stream) => this._initAudio(stream));
    }

    _initAudio(stream) {
      if (this._analyser || !stream) return;
      try {
        this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        this._audioCtx.resume().catch(() => {});
        this._analyser = this._audioCtx.createAnalyser();
        this._analyser.fftSize = 256;
        this._lv = new Uint8Array(this._analyser.fftSize);
        this._audioCtx.createMediaStreamSource(stream).connect(this._analyser);
      } catch {}
    }
    _level() {
      if (!this._analyser) return 0;
      this._analyser.getByteTimeDomainData(this._lv);
      let sum = 0;
      for (let i = 0; i < this._lv.length; i++) { const v = (this._lv[i] - 128) / 128; sum += v * v; }
      return Math.min(1, Math.sqrt(sum / this._lv.length) * 5);
    }

    _frame(now) {
      const grid = this._gridSize();
      const def = this._curDef || { row: 0, from: 0, to: 5, loop: true, fps: 8 };
      const n = def.to - def.from + 1;

      // 说话:按音量包络在 talk 行选口型帧
      if (this._state === 'talk') {
        this._env += (this._level() - this._env) * 0.3;
        this._frameIdx = Math.round(this._env * (n - 1));
      } else {
        this._env += (0 - this._env) * 0.3;
        const dur = (def.durations && def.durations[this._frameIdx]) || (1000 / (def.fps || 10));
        this._frameTime += 16.7;
        if (this._frameTime >= dur) {
          this._frameTime = 0; this._frameIdx++;
          if (this._frameIdx >= n) { if (def.loop) this._frameIdx = 0; else { this._frameIdx = n - 1; this.setState(this._map('idle')); } }
        }
      }

      const img = this._pet.img;
      if (img) {
        const cwI = img.naturalWidth, chI = img.naturalHeight;
        const cellW = cwI / grid.cols, cellH = chI / grid.rows; // 自适应:按图片尺寸 ÷ 格子数
        const col = this._frameIdx % grid.cols, row = def.row % grid.rows;
        const sx = col * cellW, sy = row * cellH;
        const c = this._ctx, cw = this._canvas.width, ch = this._canvas.height;
        c.clearRect(0, 0, cw, ch);
        c.imageSmoothingEnabled = false;
        c.drawImage(img, sx, sy, cellW, cellH, 0, 0, cw, ch);
      }
      this._raf = requestAnimationFrame((t) => this._frame(t));
    }

    destroy() {
      if (this._raf) cancelAnimationFrame(this._raf);
      if (this._audioCtx) this._audioCtx.close && this._audioCtx.close().catch(() => {});
      this.el.innerHTML = '';
    }
  }

  global.VoicePet = VoicePet;
})(window);
