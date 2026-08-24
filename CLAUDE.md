# VoiceAgent 项目说明

浏览器录音 → ASR → LLM → TTS → 播放的语音问答闭环。后端在 ASR 前用 Silero VAD 裁掉首尾静音，只把有效语音送识别。支持三路多轮对话，记忆互通：语音（`POST /api/chat`）、文字（`POST /api/chat_text`）、唤醒词免按键（WS `/api/wake`，前端常驻推 16k int16 PCM）。

**音频经独立通道流式下发**：文字/语音走 WS `/api/chat_stream`（后端一条龙 LLM 增量→断句→逐句 TTS→顺序推 PCM），唤醒路仍"回 replyText → 前端连 WS `/api/tts` 全篇合成"。HTTP 主链路（/api/chat、/api/chat_text）不返回音频；改后端时别在主链路里塞音频字节，音频走独立 WS 通道。

## 常用命令

```bash
npm install                # 只装一次,需 Node >= 18
VA_PROFILE=local npm start # 内网后端(默认,不设也走 local);端口取配置 server.port
VA_PROFILE=online npm start# 全线上(百炼 + DeepSeek,按量计费)

node --check 文件.js       # 唯一语法检查手段
```

- **无测试框架、无 linter、无构建步骤**。浏览器 SDK 是无打包的 IIFE，改完用 `node --check public/voice-agent.js` 验语法即可。
- **系统级依赖 `ffmpeg`**：`audio.js` 用 execFile 调它把 webm→16k mono wav，没装会转码失败。
- 启动后浏览器开 `http://localhost:<port>`。演示页 `index.html` 用 `autoWake:true`，加载即请求麦克风并自动监听；注意浏览器 autoplay 限制下采集 AudioContext 初始挂起，需首次点击页面才 `resume`（状态 `waiting-activation`）。
- **首次 clone 需两步**（二者都已 gitignore，仓库里没有）：
  1. 按 `server/config/README.md` 创建 `server/config/{profile}.json`（含 API key，别提交）。
  2. 准备 `server/models/silero_vad.onnx`（v5 分发版；官方 snakers4 版在此环境推理异常，见 `vad.js` 头注释）。

## 配置

- 字段说明见 `server/config/README.md`；真实值放 `server/config/local.json` / `online.json`，已被 gitignore 排除（含 API key），不要提交。
- 通过 `VA_PROFILE` 环境变量切换后端服务；唤醒词在配置 `wakeWords`（可配多个）、唤醒窗口 `wakeTimeout`（秒，窗口内免唤醒词直接问答）。
- **`config.js` 按 `VA_PROFILE` 拼 `server/config/{profile}.json`，文件缺失直接 throw**；三个环节（asr/llm/tts）的 `provider` 字段彼此独立，可任意混搭，不以档位强绑定。

## 代码结构（server/）

- `index.js` 路由 + 共享 WebSocketServer 入口。
- `asr.js` / `tts.js` / `llm.js` 各 provider 分流（asr/tts: local 内网 HTTP vs online 百炼 WS；llm: `yuxi-chat` 语析 vs `openai-compatible`）。
- `vad.js` Silero VAD（ONNX，模型在 `server/models/`）；`audio.js` 转码 webm→wav。
- `wake.js` 流式开口段检测 + 唤醒词匹配 + 自动回答；`turn.js` 会话表（多轮记忆）；`timing.js` 链路耗时打点。
- `stream.js` 流式问答管线 + `/api/chat_stream`（LLM 增量→断句→逐句 TTS→顺序推 PCM）；`sentence.js` 断句器 `SentenceBuffer`。
- `bailian.js` 阿里云百炼 WebSocket 客户端（ASR + TTS 共用握手/task 协议）。

## 代码结构（public/）

- `voice-agent.js` 前端 SDK（自包含，单 `<script>` 引入）：`VoiceAgent` 类一个入口封装三路问答（唤醒监听/按住说话/文字问答）+ 自动 TTS 播放，内联了 TtsPlayer；接入方 `new VoiceAgent({...})` 即可，不必碰 getUserMedia/WebSocket/MediaRecorder 样板。
- `index.html` 接口演示页，只调 SDK 的 UI 示例（`autoWake:true` 加载即自动开始监听）。
- 其他项目接入：接口协议与 SDK 用法（含 `baseUrl` 跨域部署）见 `docs/API.md`。

## 约定

- **共享一个 WebSocketServer**：index.js 里 `new WebSocketServer({ server })`，`/api/wake` 与 `/api/tts` 在 connection 里按 path 过滤。勿拆成两个带 path 的 WSS 挂同一 server——先注册的会把不匹配请求直接回 400。
- **多轮记忆**在 `turn.js` 的 sessions Map（单实例内存够用），语音/文字/唤醒三路共用；多实例部署需换 redis/数据库。注意 llm 返回的 context 语义随 provider 变（yuxi-chat 存 `thread_id`，openai-compatible 存消息数组），turn.js 只当不透明值存。
- **链路耗时**用 `Timing` 打点：`new Timing('chat')` → `t.mark('步骤')` → `t.log()`，统一输出排查慢在哪一步。
- **TTS 边生成边播**：后端 `synthesizeStream` 返回 { promise, cancel }，先发 `meta` 再透传 PCM 块最后 `done`；前端拿 replyText 后连 `/api/tts` 流式合成，打断直接 close，后端 cancel。
- **流式问答 `/api/chat_stream`**：文字/语音走它，后端一条龙 `llm.askStream` 增量 → `SentenceBuffer`(server/sentence.js)按标点/长度断句 → 逐句 `tts.synthesizeStream` 串行(一次一句)推 PCM。`meta` 必须在首个 PCM 字节前发；`/api/chat?stream=1` 只回 `userText`，由前端再连流式通道(避免 LLM 跑两遍污染多轮记忆)；唤醒路仍走 `/api/tts` 全篇,未改。
- **16k mono s16le 是唤醒/ASR 的音频契约**；TTS 输出按 `config.tts.sampleRate`（默认 24k）的 s16le。服务端（tts.js）与前端（TtsPlayer）都做**跨块 2 字节对齐**：流式块不保证偶数长度，直接 `new Int16Array(odd)` 会 RangeError/崩，务必 `usable & ~1` 取整后再转。`sampleRate/channels/bitsPerSample` 由 `/api/tts` 的 `meta` 下发，前后端需一致。
- **唤醒回答**去掉唤醒词后走 `turn.ask`，复用多轮记忆；ASR 异步且串行（classifying 标志防堆积）。
- **唤醒窗口休眠时间**：WS `/api/wake` 的 `wake` 事件带 `timeoutSeconds`（窗口总秒数，来自配置 `wakeTimeout`），`sleep` 事件带 `idleSeconds`（实际静默秒数）。前端 SDK 透传为 `onWake(word, timeoutSeconds)` / `onSleep(idleSeconds)`，接入方可据此自行画倒计时/进度条。
- **前端 SDK 的 `baseUrl`**：WS 地址由 `http(s)`→`ws(s)` 自动转换，同源用 `location.host`，跨域部署传 baseUrl。SDK 用 `crypto.randomUUID()` 生成一次性 sessionId（不持久化，重开即新会话）；要跨会话记忆需接入方传固定 sessionId。
- 本地 CosyVoice 音色靠 `spkId` 引用：先用 `scripts/tts-admin.html` 把参考音频注册到 TTS 服务，再把 `spkId` 配进 `config.tts.spkId`，主链路只发 `tts_text + spk_id`，不碰参考文件。
