'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const callbacks = new Map();
let rafId = 0;
const context = {
  console,
  Uint8Array,
  URLSearchParams,
  location: { search: '' },
  requestAnimationFrame(fn) { const id = ++rafId; callbacks.set(id, fn); return id; },
  cancelAnimationFrame(id) { callbacks.delete(id); },
};
context.window = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'voicepet.js'), 'utf8'), context);
const VoicePet = context.VoicePet;

const meta = {
  grid: { cols: 8, rows: 8 },
  defaultFps: 10,
  levelGain: 12,
  states: {
    idle: { row: 0, from: 0, to: 1, loop: true, fps: 10 },
    talk: { row: 1, from: 0, to: 7, loop: true, fps: 12 },
    wave: { row: 2, from: 2, to: 4, loop: false, fps: 10 },
    jump: { row: 3, from: 0, to: 2, loop: false, durations: [50, 100, 150] },
    failed: { row: 4, from: 0, to: 1, loop: false, fps: 10 },
    review: { row: 5, from: 0, to: 1, loop: false, fps: 10 },
    waiting: { row: 6, from: 0, to: 1, loop: true, fps: 10 },
  },
  mapping: {
    idle: 'idle', listening: 'idle', 'wake-active': 'idle',
    speaking: 'talk', recording: 'waiting',
  },
};

function createPet(overrides = {}) {
  const pet = new VoicePet({ el: { innerHTML: '' }, logLevel: 'off' });
  pet._pet = { name: 'test', sprite: 'test.png', meta: overrides.meta || meta, img: { naturalWidth: 1024, naturalHeight: 1024 } };
  pet._canvas = { width: 240, height: 240 };
  pet._ctx = overrides.ctx || {
    clearRect() {}, drawImage() {}, save() {}, restore() {}, translate() {}, imageSmoothingEnabled: false,
  };
  pet._baseState = 'idle';
  pet._activate('idle', 'test', true);
  return pet;
}

class FakeAgent {
  constructor() { this.listeners = {}; this.analyser = null; }
  on(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn); }
  off(name, fn) { this.listeners[name] = (this.listeners[name] || []).filter((item) => item !== fn); }
  emit(name, value) { (this.listeners[name] || []).slice().forEach((fn) => fn(value)); }
}

function advance(pet, total, slice) {
  let now = 0;
  while (now < total) { const delta = Math.min(slice, total - now); now += delta; pet._step(delta, now); }
}

(async () => {
  {
    let drawArgs;
    const pet = createPet({ ctx: {
      clearRect() {}, drawImage(...args) { drawArgs = args; }, save() {}, restore() {}, translate() {}, imageSmoothingEnabled: false,
    } });
    pet._playTransient('wave', 'test');
    pet._frameIdx = 1;
    pet._draw(0);
    assert.strictEqual(drawArgs[1], 3 * 128, '绘制列必须包含 from 偏移');
  }

  {
    const fast = createPet(); const slow = createPet();
    fast._playTransient('wave', 'test'); slow._playTransient('wave', 'test');
    advance(fast, 310, 1000 / 120); advance(slow, 310, 1000 / 60);
    assert.strictEqual(fast._state, 'idle', '120Hz 下动作应按真实时间结束');
    assert.strictEqual(slow._state, 'idle', '60Hz 下动作应按真实时间结束');
  }

  {
    const pet = createPet();
    pet._playTransient('jump', 'test');
    pet._step(49, 49); assert.strictEqual(pet._frameIdx, 0);
    pet._step(1, 50); assert.strictEqual(pet._frameIdx, 1, 'durations 应逐帧生效');
    pet._step(100, 150); assert.strictEqual(pet._frameIdx, 2);
    pet._step(150, 300); assert.strictEqual(pet._state, 'idle', '非循环动作结束后应回基础状态');
  }

  {
    const pet = createPet();
    pet._playTransient('wave', 'wake');
    pet._handleAgentState('wake-active');
    assert.strictEqual(pet._state, 'wave', '基础状态更新不能截断挥手');
    pet._handleAgentState('speaking');
    assert.strictEqual(pet._state, 'talk', '说话必须抢占普通动作');
    pet._pendingReview = true;
    pet._handleAgentState('idle');
    assert.strictEqual(pet._state, 'review', '轻点头必须在声音结束后触发');
  }

  {
    const pet = createPet();
    pet._pcmLevel = 0.28;
    pet._agentState = 'speaking'; pet._activate('talk', 'test', true);
    advance(pet, 100, 20);
    assert.ok(pet._frameIdx >= 4, '正常语音应覆盖明显的中高口型');
    pet._pcmLevel = 0;
    advance(pet, 240, 20);
    assert.strictEqual(pet._frameIdx, 0, '静音后应快速稳定闭嘴');
  }

  {
    const analyser = {
      fftSize: 256,
      getByteTimeDomainData(data) { for (let i = 0; i < data.length; i++) data[i] = 128 + (i % 2 ? 24 : -24); },
    };
    const pet = createPet();
    pet.agent = { analyser };
    assert.ok(pet._level() > 0.5, '旧 SDK 的 analyser 回退仍应可用');
  }

  {
    const pet = createPet();
    pet._playTransient('wave', 'test');
    pet._lastTick = 0;
    pet._frame(10000);
    assert.strictEqual(pet._frameIdx, 1, '后台恢复时单帧推进量必须封顶');
    callbacks.delete(pet._raf);
  }

  {
    const pet = createPet();
    const old = pet._pet;
    pet._select = { disabled: false, value: old.name };
    pet._findEntry = () => ({ name: 'bad', sprite: 'bad.webp' });
    pet._loadPet = async () => { throw new Error('load failed'); };
    pet._showTip = () => {};
    assert.strictEqual(await pet._swap('bad'), false);
    assert.strictEqual(pet._pet, old, '形象加载失败必须保留旧形象');
    assert.strictEqual(pet._select.value, old.name);
  }

  {
    const agent = new FakeAgent();
    const pet = createPet();
    pet.agent = agent; pet._subscribe(); pet._raf = 123;
    pet.destroy();
    const state = pet._state;
    agent.emit('wake');
    assert.strictEqual(pet._state, state, '销毁后必须解除事件订阅');
    assert.strictEqual(pet._subscriptions.length, 0);
  }

  console.log('voicepet.test.js 全部通过');
})().catch((error) => { console.error(error); process.exit(1); });
