# VoiceAgent 接入文档

浏览器录音 → ASR → LLM → TTS → 播放的语音问答闭环。后端提供 2 个 HTTP 接口 + 2 个 WebSocket 通道；前端把三路问答封装成一个 `VoiceAgent` SDK，多数接入方**直接引 SDK** 即可，不用碰底层协议。

## 一、最快接入（前端 SDK）

把 `public/voice-agent.js` 复制/托管到你的项目，然后：

```html
<script src="voice-agent.js"></script>
<script>
  const agent = new VoiceAgent({
    baseUrl: 'http://<host>:3000',      // 后端地址;跨域/独立部署必填,同源可省略
    autoWake: true,                     // 加载即自动开始唤醒词监听
    sessionId: 'user-001',              // 可选;单次对话的会话 id,同一次对话内连续问答共享上下文
    onUserText: (text) => console.log('你说:', text),
    onReply: (text) => console.log('助手:', text), // 拿到回复,已自动 TTS 播放
    onError: (msg) => console.error(msg),
  });

  agent.askText('你好');      // 文字问答
  agent.startWake();          // 手动开始唤醒监听(只有 autoWake:false 时需要)
  agent.stopWake();           // 停止唤醒监听
  agent.wakeManual();         // 手动唤醒:免唤醒词进入唤醒窗口(唤醒词检测不到时兜底)
  agent.startRecording();     // 按住说话:开始录音
  agent.stopRecording();      // 按住说话:松开发送,返回 {replyText,userText} 或 null
  agent.stopPlay();           // 打断播放
</script>
```

### 选项

| 选项 | 类型 | 说明 |
|---|---|---|
| `baseUrl` | string | 后端地址，如 `http://192.168.1.5:3000`（带协议）。跨域/独立部署时必填；缺省用同源相对路径。 |
| `sessionId` | string | 单次对话的会话 id，语音/文字/唤醒三路共用。同一次对话内（同一 sessionId）连续问答共享上下文；不传则本次实例随机生成，刷新/重开即新对话，不跨会话持久化。要跨会话记忆就传固定 id。 |
| `autoWake` | boolean | `true` 则构造后自动开始唤醒监听。 |

### 回调

| 回调 | 触发时机 |
|---|---|
| `onUserText(text)` | 识别到用户说的话（三路都触发） |
| `onReply(text)` | 得到回复文本（已自动 TTS 播放） |
| `onWake(word, timeoutSeconds)` | 命中唤醒词；`timeoutSeconds` = 唤醒窗口总秒数（可画倒计时） |
| `onSleep(idleSeconds)` | 唤醒窗口超时休眠；`idleSeconds` = 实际静默秒数 |
| `onInterrupt()` | 开口打断正在播的回答 |
| `onAudioStream(stream)` | TTS 播放流创建后回调（`MediaStream`，供 Live2D 口型同步等消费）；另有 getter `agent.audioStream` |
| `onStateChange(state)` | 状态：`idle / starting / waiting-activation / listening / wake-active / sleep / recording / speaking` |
| `onError(msg)` | 错误 |

## 二、后端接口协议

### POST /api/chat — 语音问答

请求 `multipart/form-data`：

| 字段 | 说明 |
|---|---|
| `audio` | webm/mp4 录音文件 |
| `sessionId` | 可选，会话 id；同一次对话内连续问答共享上下文 |

后端处理：转码 → VAD 裁静音 → ASR → LLM。音频合成不在本接口返回，由前端连 `/api/tts` 流式播放。

响应 `200`：`{ "replyText": "...", "userText": "..." }`
错误：非 2xx + `{ "error": "原因" }`

### POST /api/chat_text — 文字问答

请求 `application/json`：

```json
{ "text": "你好", "sessionId": "user-001" }
```

跳过 ASR 直接 LLM，响应同上 `{replyText, userText}`。

### WS /api/wake — 唤醒词监听

前端连上后**持续发送二进制 PCM 块**：16kHz、单声道、s16le（裸 int16）。后端用 VAD + ASR 检测唤醒词，命中自动回答（去掉唤醒词，剩余文本走 LLM）。URL 参数 `?sessionId=xxx` 可选（会话 id，同一会话内连续问答共享上下文）。

后端回 JSON 文本帧：

| type | payload | 说明 |
|---|---|---|
| `wake` | `{ word, timeoutSeconds }` | 命中唤醒词，进入唤醒窗口 |
| `answer` | `{ userText, replyText }` | 自动回答 |
| `interrupt` | — | 检测到你开口，打断正在播的回答 |
| `sleep` | `{ idleSeconds }` | 唤醒窗口超时休眠 |

前端也可发 `{"type":"wake_manual"}` 手动唤醒（免唤醒词直接进入窗口，`agent.wakeManual()` 即此协议），用于唤醒词检测不到时兜底。

唤醒词与窗口时长由后端配置：`server/config/{profile}.json` 的 `wakeWords` / `wakeTimeout`。

### WS /api/tts — 流式 TTS 合成

请求（JSON 文本帧）：

```json
{ "type": "synthesize", "text": "要合成的文本" }
```

响应顺序：

1. `{ "type": "meta", "sampleRate": 24000, "channels": 1, "bitsPerSample": 16 }`
2. 一个或多个**二进制帧**（裸 s16le PCM）
3. `{ "type": "done" }` 结束，或 `{ "type": "error", "message": "..." }`

打断：直接 `ws.close()`，后端停止合成。

## 三、跨域部署

其他项目与后端不同源时：

1. 前端 SDK 传 `baseUrl`（如 `http://192.168.1.5:3000`）。WS 地址会自动把 `http(s)://` 转成 `ws(s)://`。
2. 后端已放开 CORS（`Access-Control-Allow-Origin: *`），无需额外配置。要收紧就改 `server/index.js` 的 CORS 中间件。

注意：`baseUrl` 的协议要匹配后端实际协议——后端是 https，`baseUrl` 也要 `https://`，否则浏览器会拦混内容 WS。

## 四、错误处理

- HTTP 接口：非 2xx 返回 `{ "error": "原因" }`。
- WS TTS：`{ type: 'error', message }`。
- SDK 层：统一走 `onError(msg)` 回调。

## 五、后端启动

```bash
VA_PROFILE=local  npm start   # 内网后端
VA_PROFILE=online npm start   # 全线上
```

端口取 `server/config/{profile}.json` 的 `server.port`（默认 local=3000 / online=30002）。
