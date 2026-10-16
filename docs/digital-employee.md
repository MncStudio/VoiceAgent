# digital-employee 语音接入

分支 `codex/digital-employee-voice` 基于 `feat/chuyun-integration`，用于当前数字员工项目。

数字员工现有面板负责问答、付款诊断 SSE、工具步骤和格式化显示；本服务只负责唤醒、ASR 和朗读。通过 SDK 新增的可选 `onQuestion` 回调，将识别文字交还面板；配置该回调时不会请求 `/api/chat_stream`，也不会自动朗读旧服务端返回的 `replyText`。不传该选项时继续使用原有问答行为。

```js
const voice = new VoiceAgent({
  baseUrl: location.origin + '/voice-api',
  wakeRequireWord: true,
  interruptOnSpeech: false,
  onWake() { openExistingPanel(); },
  async onQuestion(text) {
    const answer = await askExistingAgent(text);
    await voice.speak(extractPlainText(answer));
  },
  onError(message) { showVoiceStatus(message); },
});

// 首次点击时解锁声音；开始后先唤醒，再说下一段问题。
enableButton.onclick = async () => {
  await voice.activateAudio();
  await voice.startWake();
};

// 组件销毁时释放资源，包括授权后才迟到的麦克风采集。
// voice.destroy();
```

`speak()` 只调用 `/api/tts`，由接入方清理 HTML 样式、Markdown 和表格边框。`playing/idle` 上报继续用于回声过滤。当前 digital-employee 使用回答完整结束后朗读，关闭面板会取消当前/待开始的朗读，监听保留到手动关闭或离开页面。

`speak()` 将长回答分成最多 240 字的片段，串行合成并等待每段实际音频播放完，再处理下一段；不会摘要或截掉后续内容。其 Promise 在整段回答播完或被打断后结束。每次上报当前播报段供回声判断，段间状态保持 speaking；合成出错时停止余下队列并通过 onError 提示。

本接入关闭环境人声打断。SDK 通过 `/api/wake?requireWake=1&interruptOnSpeech=0` 与服务端协商，仅保留唤醒和明确停止指令。其他未传参数的接入方沿用全局策略。`interrupt` 事件增加 `reason`（speech、stop-word、wake、question），用于区分停止原因。

数字员工开发代理 `/voice-api` 默认指向本服务 `http://localhost:3000`；生产环境需配置同等的 HTTP/WebSocket 代理并使用 HTTPS。唤醒词仍读取本服务配置。

同步 SDK 时将 `public/voice-agent.js` 复制到 digital-employee 的 `public/voice-agent.js`。运行 `npm test` 验证原行为与新增外部问答模式。
