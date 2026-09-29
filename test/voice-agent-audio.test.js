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
