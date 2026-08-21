# VoiceAgent 项目说明

浏览器录音 → ASR → LLM → TTS → 播放的语音问答闭环。后端在 ASR 前用 Silero VAD 裁掉首尾静音，只把有效语音送识别。支持三路多轮对话，记忆互通：语音（`POST /api/chat`）、文字（`POST /api/chat_text`）、唤醒词免按键（WS `/api/wake`，前端常驻推 16k int16 PCM）。

## 常用命令

```bash
npm install                # 只装一次
VA_PROFILE=local npm start # 内网后端(默认,不设也走 local)
VA_PROFILE=online npm start# 全线上(百炼 + 语析,按量计费)
```

## 配置

- 字段说明见 `server/config/README.md`；真实值放 `server/config/local.json` / `online.json`，已被 gitignore 排除（含 API key），不要提交。
- 通过 `VA_PROFILE` 环境变量切换后端服务；唤醒词在配置 `wakeWords`（可配多个）、唤醒窗口 `wakeTimeout`（秒，窗口内免唤醒词直接问答）。

## 代码结构（server/）

- `index.js` 路由 + 共享 WebSocketServer 入口。
- `asr.js` / `tts.js` / `llm.js` 各 provider 分流（asr/tts: local 内网 HTTP vs online 百炼 WS；llm: `yuxi-chat` 语析 vs `openai-compatible`）。
- `vad.js` Silero VAD（ONNX，模型在 `server/models/`）；`audio.js` 转码 webm→wav。
- `wake.js` 流式开口段检测 + 唤醒词匹配 + 自动回答；`turn.js` 会话表（多轮记忆）；`timing.js` 链路耗时打点。

## 代码结构（public/）

- `voice-agent.js` 前端 SDK（自包含，单 `<script>` 引入）：`VoiceAgent` 类一个入口封装三路问答（唤醒监听/按住说话/文字问答）+ 自动 TTS 播放，内联了 TtsPlayer；接入方 `new VoiceAgent({...})` 即可，不必碰 getUserMedia/WebSocket/MediaRecorder 样板。
- `index.html` 接口演示页，只调 SDK 的 UI 示例（`autoWake:true` 加载即自动开始监听）。
- 其他项目接入：接口协议与 SDK 用法（含 `baseUrl` 跨域部署）见 `docs/API.md`。

## 约定

- **共享一个 WebSocketServer**：index.js 里 `new WebSocketServer({ server })`，`/api/wake` 与 `/api/tts` 在 connection 里按 path 过滤。勿拆成两个带 path 的 WSS 挂同一 server——先注册的会把不匹配请求直接回 400。
- **多轮记忆**在 `turn.js` 的 sessions Map（单实例内存够用），语音/文字/唤醒三路共用；多实例部署需换 redis/数据库。
- **链路耗时**用 `Timing` 打点：`new Timing('chat')` → `t.mark('步骤')` → `t.log()`，统一输出排查慢在哪一步。
- **TTS 边生成边播**：后端 `synthesizeStream` 返回 { promise, cancel }，先发 `meta` 再透传 PCM 块最后 `done`；前端拿 replyText 后连 `/api/tts` 流式合成，打断直接 close，后端 cancel。
- **唤醒回答**去掉唤醒词后走 `turn.ask`，复用多轮记忆；ASR 异步且串行（classifying 标志防堆积）。
- **唤醒窗口休眠时间**：WS `/api/wake` 的 `wake` 事件带 `timeoutSeconds`（窗口总秒数，来自配置 `wakeTimeout`），`sleep` 事件带 `idleSeconds`（实际静默秒数）。前端 SDK 透传为 `onWake(word, timeoutSeconds)` / `onSleep(idleSeconds)`，接入方可据此自行画倒计时/进度条。
