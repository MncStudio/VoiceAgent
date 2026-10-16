'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sockets = [];
class FakeWebSocket {
  static OPEN = 1;
  constructor() { this.readyState = 1; sockets.push(this); }
  send(data) { this.request = JSON.parse(data); }
  close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  finish() { this.onmessage({ data: JSON.stringify({ type: 'done' }) }); }
}
const context = { console, setTimeout, clearTimeout, Int16Array, Uint8Array, Float32Array,
  WebSocket: FakeWebSocket, location: { protocol: 'http:', host: 'localhost:3000' } };
context.window = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/voice-agent.js'), 'utf8'), context);

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); }
  throw new Error('等待播放状态超时');
}
function open(ws) { ws.onopen(); }

(async () => {
  const states = [];
  const errors = [];
  const agent = new context.VoiceAgent({ interruptOnSpeech: false, onStateChange: (s) => states.push(s), onError: (e) => errors.push(e) });
  agent._tts._ensureAudioCtx = async () => ({ currentTime: 0 });
  const text = Array.from({ length: 45 }, (_, i) => `第${i + 1}项诊断：合同金额12,345.67元，审批停留27天，请核实付款进度并联系办理人。`).join('\n') + '\n最后一段说明必须完整播报。';
  const sent = [];
  let done = false;
  const playback = agent.speak(text).then(() => { done = true; });
  await until(() => sockets.length === 1);
  open(sockets[0]);
  agent._onWakeMessage({ type: 'interrupt', reason: 'speech' });
  assert.equal(agent._speakingSequence, true, '附近人说话不能在标题后打断正文');
  assert.equal(agent._tts.speakingText, sockets[0].request.text, '回声判定应包含当前实际播报段的开头');
  const queuedAudio = { stop() {} };
  agent._tts._activeSources.add(queuedAudio);
  sockets[0].finish();
  await tick();
  assert.equal(sockets.length, 1, '收到合成 done 后仍要等音频播完，不能提前开始下一段');
  agent._tts._activeSources.delete(queuedAudio);
  agent._tts._maybeFinish(agent._tts._playGen);
  sent.push(sockets[0].request.text);
  let processed = 1;
  let iterations = 0;
  while (!done) {
    assert.ok(++iterations < 1000, '队列必须能结束，不得永远等待');
    await tick();
    if (processed < sockets.length) {
      const ws = sockets[processed++];
      open(ws);
      sent.push(ws.request.text);
      ws.finish();
    }
  }
  await playback;
  assert.ok(sent.length > 5);
  assert.ok(sent.every((part) => Array.from(part).length <= 240));
  assert.equal(sent.join('').replace(/\s/g, ''), text.replace(/\s/g, ''), '各段拼起来必须覆盖全文，不得摘要或漏字');
  assert.match(sent.at(-1), /最后一段说明必须完整播报。$/);
  assert.deepEqual(states, ['speaking', 'idle'], '段落间不能误显示成等待唤醒');

  const beforeCancel = sockets.length;
  const canceled = agent.speak(text);
  await until(() => sockets.length > beforeCancel);
  open(sockets.at(-1));
  agent.stopPlay();
  await canceled;
  await tick();
  assert.equal(sockets.length, beforeCancel + 1, '打断后不得继续合成剩余段落');

  const beforeError = sockets.length;
  const failed = agent.speak(text);
  await until(() => sockets.length > beforeError);
  open(sockets.at(-1));
  sockets.at(-1).onmessage({ data: JSON.stringify({ type: 'error', message: '合成失败' }) });
  await failed;
  assert.equal(sockets.length, beforeError + 1, '合成失败时应停止队列并提示，不得悄悄跳段');
  assert.match(errors.at(-1), /合成失败/);

  const beforeDisconnect = sockets.length;
  const disconnected = agent.speak(text);
  await until(() => sockets.length > beforeDisconnect);
  open(sockets.at(-1));
  sockets.at(-1).close();
  await disconnected;
  assert.equal(sockets.length, beforeDisconnect + 1);
  assert.match(errors.at(-1), /尚未读完/);

  const beforeStopWord = sockets.length;
  const stopWord = agent.speak(text);
  await until(() => sockets.length > beforeStopWord);
  open(sockets.at(-1));
  agent._onWakeMessage({ type: 'interrupt', reason: 'stop-word' });
  await stopWord;
  assert.equal(sockets.length, beforeStopWord + 1, '明确停止指令仍要取消剩余段落');
  console.log('long-speech.test.js 全部通过');
})().catch((error) => { console.error(error); process.exitCode = 1; });
