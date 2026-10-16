'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function setup(extra = {}) {
  const context = { console, setTimeout, clearTimeout, Int16Array, Uint8Array, Float32Array,
    location: { protocol: 'http:', host: 'localhost:5173' }, ...extra };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/voice-agent.js'), 'utf8'), context);
  return context;
}

(async () => {
  const ctx = setup();
  const questions = [];
  const echoed = [];
  const errors = [];
  const agent = new ctx.VoiceAgent({
    onQuestion: (text) => questions.push(text),
    onUserText: (text) => echoed.push(text),
    onError: (message) => errors.push(message),
  });
  agent._tts.playStream = () => { throw new Error('外部模式不能请求第二条 LLM 链路'); };
  agent._tts.play = async (text) => { agent.spoken = text; };
  agent._onWakeMessage({ type: 'answer', userText: '付款为什么没完成', replyText: '旧接口的回答' });
  await agent.askText('另一个问题');
  await Promise.resolve();
  assert.deepEqual(questions, ['付款为什么没完成', '另一个问题']);
  assert.deepEqual(echoed, questions);
  assert.equal(agent.spoken, undefined, '外部模式不自动朗读服务端旧回答');
  await agent.speak('付款仍在审批中。');
  assert.equal(agent.spoken, '付款仍在审批中。');
  assert.equal(errors.length, 0);

  const rejected = new ctx.VoiceAgent({ onQuestion: async () => { throw new Error('业务服务不可用'); }, onError: (e) => errors.push(e) });
  rejected._streamReply('提问');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(errors.at(-1), /业务服务不可用/);

  let release;
  let stopped = 0;
  let captures = 0;
  const pendingContext = setup({ navigator: { mediaDevices: { getUserMedia: () => {
    captures++;
    return new Promise((resolve) => { release = resolve; });
  } } } });
  const pendingAgent = new pendingContext.VoiceAgent();
  const first = pendingAgent.startWake();
  const duplicate = pendingAgent.startWake();
  assert.equal(captures, 1, '连续启动只能申请一次麦克风');
  pendingAgent.destroy();
  release({ getTracks: () => [{ stop: () => { stopped++; } }] });
  await Promise.all([first, duplicate]);
  assert.equal(stopped, 1, '销毁后迟到的麦克风授权必须释放');
  assert.equal(pendingAgent.wakeActive, false);

  const stateContext = setup({ WebSocket: { OPEN: 1 } });
  const statusAgent = new stateContext.VoiceAgent();
  statusAgent._wakeOn = true;
  statusAgent._ctxRunning = true;
  statusAgent._wakeWs = { readyState: 0 };
  statusAgent._refreshState();
  assert.equal(statusAgent._state, 'starting', '连接未建立时不能显示等待唤醒');
  statusAgent._wakeWs.readyState = 1;
  statusAgent._refreshState();
  assert.equal(statusAgent._state, 'listening');
  statusAgent._ctxRunning = false;
  statusAgent._refreshState();
  assert.equal(statusAgent._state, 'waiting-activation');
  statusAgent._tts._ensureAudioCtx = async () => ({});
  statusAgent._wakeCtx = { state: 'suspended', resume: async () => { statusAgent._wakeCtx.state = 'running'; } };
  await statusAgent.activateAudio();
  assert.equal(statusAgent._state, 'listening', '点击启用必须同时激活唤醒采集与声音播放');
  console.log('external-question.test.js 全部通过');
})().catch((error) => { console.error(error); process.exitCode = 1; });
