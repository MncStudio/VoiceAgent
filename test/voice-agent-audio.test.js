'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = {
  console,
  setTimeout,
  clearTimeout,
  Uint8Array,
  Int16Array,
  Float32Array,
  URLSearchParams,
  location: { protocol: 'http:', host: 'localhost:3000' },
};
context.window = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'voice-agent.js'), 'utf8'), context);

(async () => {
  // ---- 外放回声下的"让路"(barge-in):有人说话就把 TTS 压静音,让唤醒通道听清唤醒词 ----
  {
    const a = new context.VoiceAgent({});
    a._tts._playing = true; // 假装正在播
    a._onTtsPlayingChange(true);
    let now = Date.now(); // 用真实时钟：_onTtsPlayingChange 里的 grace 也是 Date.now()
    // 起播头 700ms 是底噪建立期:即使电平有波动也不该让路
    for (let i = 0; i < 6; i++) { a._bargeInTick(0.15, now); now += 100; }
    assert.strictEqual(a._yielding, false, 'grace 期内不该让路(含让路判定前)');
    for (let i = 0; i < 3; i++) { a._bargeInTick(0.15, now); now += 100; }
    assert.strictEqual(a._yielding, false, 'grace 期内不该让路');
    // 用户开口:电平远高于回声底噪 → 立刻让路
    a._bargeInTick(0.5, now);
    assert.strictEqual(a._yielding, true, '用户说话要立刻让路');
    assert.strictEqual(a._tts._ducked, true, '让路 = TTS 压静音');
    // 继续说 → 续期
    now += 500; a._bargeInTick(0.45, now);
    assert.strictEqual(a._yielding, true);
    // 不说了 → 恢复
    now += 100; a._bargeInTick(0.01, now); now += 1200; a._bargeInTick(0.01, now);
    assert.strictEqual(a._yielding, false, '安静下来要恢复播放');
    assert.strictEqual(a._tts._ducked, false);
    // 单次让路有上限(别把整段回答吞掉)
    now += 100; a._bargeInTick(0.6, now);
    assert.strictEqual(a._yielding, true);
    now += 3100; a._bargeInTick(0.6, now);
    assert.strictEqual(a._yielding, false, '超过 maxMs 必须恢复');
    // 播放结束一定恢复
    now += 100; a._bargeInTick(0.6, now);
    a._tts._playing = false;
    a._bargeInTick(0.01, now);
    assert.strictEqual(a._yielding, false);
    // 可关掉
    const b = new context.VoiceAgent({ bargeIn: false });
    b._tts._playing = true; b._onTtsPlayingChange(true);
    b._bargeInTick(0.9, Date.now() + 10_000);
    assert.strictEqual(b._yielding, false, 'bargeIn:false 时不做让路');
  }

  const optionLevels = [];
  const listenerLevels = [];
  const agent = new context.VoiceAgent({ onAudioLevel: (level) => optionLevels.push(level) });
  agent.on('audioLevel', (level) => listenerLevels.push(level));
  agent._tts.onAudioLevel(0.35);
  assert.deepStrictEqual(optionLevels, [0.35]);
  assert.deepStrictEqual(listenerLevels, [0.35], 'audioLevel 应同时支持构造回调和事件订阅');

  const scheduled = [];
  agent._tts.onAudioLevel = (level) => scheduled.push(level);
  const samples = new Float32Array(2400);
  samples.fill(0.25);
  agent._tts._scheduleAudioLevels(agent._tts._playGen, { currentTime: 0 }, samples, 24000, 0);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(scheduled.some((level) => level > 0.24 && level < 0.26), 'PCM RMS 应按播放时刻输出');
  assert.strictEqual(scheduled[scheduled.length - 1], 0, 'PCM 块结束后应回到静音');

  agent._tts._scheduleAudioLevels(agent._tts._playGen, { currentTime: 0 }, samples, 24000, 1);
  agent._tts.stop();
  assert.strictEqual(agent._tts._levelTimers.size, 0, '打断播放必须清理未触发的口型计时器');

  agent._tts._setPlaying(true);
  agent._tts._ttsWs = {};
  agent._tts._activeSources.add({});
  agent._tts._maybeFinish(agent._tts._playGen);
  assert.strictEqual(agent._tts.playing, true, '流式连接仍在时，句间音频空窗不能结束 speaking');
  agent._tts._activeSources.clear();
  agent._tts._maybeFinish(agent._tts._playGen);
  assert.strictEqual(agent._tts.playing, true, '即使当前无音块，连接仍在也必须保持 speaking');
  agent._tts._ttsWs = null;
  agent._tts._maybeFinish(agent._tts._playGen);
  assert.strictEqual(agent._tts.playing, false, '连接结束且最后音块播完后才能结束 speaking');

  console.log('voice-agent-audio.test.js 全部通过');
})().catch((error) => { console.error(error); process.exit(1); });
