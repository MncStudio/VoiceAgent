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
| 播放状态上报 | — | SDK 向 `/api/wake` 发 `{type:'playing', text}` / `{type:'idle'}`，其中 `text` 为实际播报文本。后端过滤回声；播放中喊“唤醒词 + 问题”可直接打断并回答。 |
| `wakeRequireWord` | boolean | 缺省 `true`，每次提问都需唤醒词；只说唤醒词后可在短窗口内直接提问。设为 `false` 时连接带 `?requireWake=0`，恢复长窗口连续问答。 |
| `newSessionPerAsk` | boolean | `true` 则**每次提问换一个会话 id**（"每次提问都是新对话"，不带上一轮上下文；每次提问在后端各建一条对话记录）。缺省 `false` 沿用同一段多轮上下文。 |
| `sessionId` | string | 单次对话的会话 id，语音/文字/唤醒三路共用。同一次对话内（同一 sessionId）连续问答共享上下文；不传则本次实例随机生成，刷新/重开即新对话，不跨会话持久化。要跨会话记忆就传固定 id。 |
| `autoWake` | boolean | `true` 则构造后自动开始唤醒监听。 |

### 回调

| 回调 | 触发时机 |
|---|---|
| `onUserText(text)` | 识别到用户说的话（三路都触发） |
| `onReply(text)` | 得到回复文本（已自动 TTS 播放） |
| `onWake(word, timeoutSeconds, followUp)` | 命中唤醒词；`followUp` 表示只说唤醒词后的短窗口 |
| `onSleep(idleSeconds)` | 唤醒窗口超时休眠；`idleSeconds` = 实际静默秒数 |
| `onInterrupt()` | 开口打断正在播的回答 |
| `onAudioStream(stream)` | TTS 播放流创建后回调（`MediaStream`，供 Live2D 口型同步等消费）；另有 getter `agent.audioStream` |
| `onAudioLevel(level)` | 与实际 PCM 播放时刻对齐的短时音量（`0..1`），数字人口型同步首选；不受浏览器音频图优化影响 |
| `onStateChange(state)` | 状态：`idle / starting / waiting-activation / listening / wake-active / sleep / recording / speaking` |
| `onError(msg)` | 错误 |

> 除构造选项回调外，还可 `agent.on(name, fn)` / `agent.off(name, fn)` 订阅事件（附加层/宠物/数字人用，不占用上面的回调）：事件名 `stateChange / wake / sleep / interrupt / error / userText / reply / audioStream / audioLevel`。桌面宠物组件 `VoicePet`(public/voicepet.js) 即基于此驱动。

## 二、后端接口协议

### POST /api/chat — 语音问答

请求 `multipart/form-data`：

| 字段 | 说明 |
|---|---|
| `audio` | webm/mp4 录音文件 |
| `sessionId` | 可选，会话 id；同一次对话内连续问答共享上下文 |

后端处理：转码 → VAD 裁静音 → ASR，只回识别文本 `{userText}`（不调 LLM）；由前端把识别文本送去 `/api/chat_stream` 流式问答（语音两跳第一跳）。

响应 `200`：`{ "userText": "..." }`
错误：非 2xx + `{ "error": "原因" }`

### GET /api/pets — 宠物形象只读列表

列出 `public/pets/` 下的 `*.png|webp` 及其配对 `<名>.json`（桌面宠物，规范见 [docs/pet-prompt.md](pet-prompt.md)）。

响应 `200`：

```json
{ "pets": [ { "name": "demo", "sprite": "demo.png", "meta": { "name": "小能", "frame": { "w": 128, "h": 128 }, "states": { ... } } } ] }
```

> 只读、不写盘；渲染由前端 `VoicePet`(public/voicepet.js) 完成。把 AI 按规范生成的 `xxx.png` + `xxx.json` 放进 `public/pets/` 即可在此列表中自动出现。

### WS /api/wake — 唤醒词监听

前端连上后**持续发送二进制 PCM 块**：16kHz、单声道、s16le（裸 int16）。后端用 VAD + ASR 检测唤醒词；同一句带问题时去掉唤醒词，剩余文本走 `/api/chat_stream` 流式问答；只说唤醒词时安静等待后续提问。URL 参数 `?sessionId=xxx` 可选（会话 id，同一会话内连续问答共享上下文）。

后端回 JSON 文本帧：

| type | payload | 说明 |
|---|---|---|
| `wake` | `{ word, timeoutSeconds, followUp? }` | 命中唤醒词，进入唤醒窗口 |
| `answer` | `{ userText }` | 识别到问题后请求回答 |
| `interrupt` | — | 检测到你开口，打断正在播的回答 |
| `sleep` | `{ idleSeconds }` | 唤醒窗口超时休眠 |

前端也可发 `{"type":"wake_manual"}` 手动唤醒（免唤醒词直接进入窗口，`agent.wakeManual()` 即此协议），用于唤醒词检测不到时兜底。

唤醒词与窗口时长由后端配置：`server/config/local.json` 的 `wakeWords` / `wakeTimeout`。

**默认每次提问都要唤醒词**，避免长窗口内的环境闲聊进入 LLM。全局可用 `wakeRequireWord: false` 关闭；单连接可用 `/api/wake?requireWake=1/0` 或 SDK 选项覆盖。开启后：

- 命中唤醒词只回答本句（`wake` → `answer`），**不开**"窗口内免唤醒词"的窗口，紧接着补一个 `sleep`（`idleSeconds: 0`）让前端的"已唤醒"指示与本轮一起复位；
- 没说唤醒词的话整段丢弃，不进 LLM；
- 只说唤醒词会安静打开默认 15 秒的短跟随窗口，从识别到唤醒词时开始计时；默认每问唤醒模式下接到一个问题就关闭窗口。手动唤醒（`wake_manual`）仍开一次长窗口；
- 播报期间带唤醒词提问会打断旧播报并直接回答。识别到非回声发言但没听清唤醒词时只停播，不自动问答。

### WS /api/chat_stream — 流式问答（LLM 增量 → 断句 → 逐句 TTS → 顺序播放）

语音/文字问答的**流式通道**：后端一条龙 `LLM 流式增量 → 断句器切句 → 逐句串行 TTS → 顺序推 PCM`，首句音频不用等整段回复生成完。前端连 `WS /api/chat_stream?sessionId=xxx`（sessionId 用于多轮记忆）。

请求（JSON 文本帧，open 后发一条）：

```json
{ "type": "chat", "text": "你的问题" }
```

响应（严格按序）：

1. `{ "type": "start", "userText": "..." }` — 回显问题。
2. `{ "type": "meta", "sampleRate": 24000, "channels": 1, "bitsPerSample": 16 }` — **必须先于首个二进制字节**，前端解码依它。
3. `{ "type": "delta", "text": "..." }`（LLM 增量，供流式字幕）、`{ "type": "speech", "text": "..." }`（本句实际送 TTS 的播报文本，供回声过滤）与一个或多个**二进制帧**（裸 s16le PCM）交错推送。
4. `{ "type": "done", "replyText": "完整回复", "speechText": "实际播报的精简文本" }`（TTS 队列全部合成完才发），或 `{ "type": "error", "message": "..." }`。

> **显示文本 ≠ 播报文本**（`speech.mode` 三选一）：
> - `full`（缺省，也是本项目当前选择：一个 LLM）：语音播报 = LLM 的完整回答（只清掉 HTML/Markdown 排版噪声），数字人答什么就念什么。
> - `llm`（可选，额外一条链路）：主回答完整后，后端用**另一条独立 LLM 链路**（`speech.summary`，可用不同 provider/key/模型）带「数字人播报员」角色提示把它改写成 20~50 字口语播报（明确禁止念表格/Markdown/代码/编号），TTS 只念这段；弹窗/字幕拿到的仍是完整回答。改写失败自动退回规则精简。
> - `key-numbers`（可选，规则精简）：`delta` 与 `done.replyText` 始终是 LLM 完整回复（弹窗/字幕照全文显示）；推给前端的 PCM 与 `done.speechText` 是配置 `speech.mode` 决定的播报文本。默认 `key-numbers`：只念含数字的片段（"库存总量为 12,345 件，其中原材料 5,678 件，此外建议关注临期物料" → 只念带数字的两段；纯叙述不念），整段回复一个数字都没有时兜底按句念完整回复，避免"有问无声"。`speech.mode: "full"` 则播报=完整回复。

打断：直接 `ws.close()`；后端取消 LLM 请求（abort SSE）、停当前合成、清空队列并复位断句器。

> 断句：LLM 增量 token 不能直接喂 TTS（无断句、语音断续），后端用断句器按句末标点（。！？…、换行）或长度上限切句。歌词/逗号不硬切（软切默认关）。
> 前端 SDK 已内置（`askText`/`_sendAudio` 自动改走本通道，语音/文字/唤醒带问题都汇聚到它）。

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
npm start                 # 直接启动:固定加载 server/config/local.json(无需环境变量)
```

> `local.json` 不存在时,启动会**报错并自动打开配置生成页**(`public/config-builder.html`,纯前端):生成并下载 `local.json`、放进 `server/config/` 后重新 `npm start`。想在一台机器上并存多套配置,把文件改名后用 `VA_PROFILE=<名字> npm start` 指向。端口取所加载配置的 `server.port`。
