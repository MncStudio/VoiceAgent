# 配置说明（server/config）

后端配置文件，JSON 格式。启动时由 [config.js](../config.js) 按环境变量 `VA_PROFILE` 加载 `server/config/{profile}.json`，默认 `local`。

## 使用方式

1. 参考下方「完整示例」创建 `config/local.json` 或 `config/online.json`，填真实值。
2. 用 `VA_PROFILE` 切换档位：

```bash
VA_PROFILE=local  npm start   # 内网后端（默认，不设也走 local）
VA_PROFILE=online npm start   # 全线上（百炼 + DeepSeek，按量计费）
```

> `local.json` / `online.json` 含 API key，已被 `.gitignore` 排除，**不要提交**。

## 两种档位

| 档位 | ASR（识别） | LLM（模型） | TTS（合成） |
|---|---|---|---|
| **local** | 内网 Paraformer HTTP | 内网语析 agent/runs | 内网 CosyVoice HTTP |
| **online** | 百炼 Paraformer WS | DeepSeek（OpenAI 兼容） | 百炼 CosyVoice WS |

三个环节各有两个实现，靠各自的 `provider` 字段二选一。同一份配置里 ASR / LLM / TTS 的 provider 独立选择，不强绑定档位。

---

## 顶层字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `profile` | string | 仅作标识，与文件名保持一致便于人读；不影响加载逻辑（加载看 `VA_PROFILE`）。 |
| `wakeWords` | string[] | 唤醒词列表，可配多个，命中任意一个即唤醒，支持同音容错。 |
| `wakeTimeout` | number（秒） | 唤醒窗口总秒数：命中唤醒词后这段时间内免唤醒词连续问答；随 `/api/wake` 的 `wake` 事件 `timeoutSeconds` 下发给前端。 |
| `vad` | object | 唤醒检测的 VAD 判定参数：`threshold`(语音概率阈值)、`startFrames`(连续语音帧数判开口)、`endFrames`(连续静音帧数判段结束)。缺省 0.55/3/15。门槛越低越不丢开头字、但环境噪音误触发多;越高反之。 |

## server

| 字段 | 类型 | 说明 |
|---|---|---|
| `port` | number | 监听端口。HTTP 与 WebSocket（`/api/wake`、`/api/tts`）共用同一个 http server。 |
| `tmpDir` | string | 临时目录。转码中间产物（webm→wav）与 VAD 输出落盘于此，用完即删（见 `audio.js`）。 |

---

## asr（语音识别：音频 → 文字）

`provider` 二选一：

| provider | 实现 | 传输方式 |
|---|---|---|
| `paraformer-http` | 内网 Paraformer | HTTP，一次 POST 传 wav 文件 |
| `paraformer-ws` | 百炼 Paraformer | WebSocket，流式 |

| 字段 | 类型 | 适用 provider | 说明 |
|---|---|---|---|
| `provider` | string | — | 枚举值见上表。 |
| `url` | string | 两个都 | 服务地址。http 档填内网 `http://<host>:50001`，ws 档填百炼 `wss://...`。 |
| `endpoint` | string | http | 拼在 `url` 后面的请求路径。 |
| `apiKey` | string | ws | 百炼鉴权 token（握手阶段放 Authorization header）。 |
| `model` | string | ws | 百炼 ASR 模型名，如 `paraformer-realtime-v2`。 |
| `format` | string | ws | 输入音频封装格式，如 `wav`。 |
| `sampleRate` | number | ws | 输入音频采样率，如 `16000`。 |
| `timeoutMs` | number | 两个都 | 单次识别超时（ms）。 |

## llm（大模型：文字 → 回复）

`provider` 三选一：

| provider | 实现 | 多轮记忆上下文 |
|---|---|---|
| `yuxi-chat` | 语析 openapi chat：POST `{url}/yuxi/openapi/v1/agents/{agentId}/chat`，SSE 流式（`stream:true`），累加 `message_delta` 成完整回复 | `thread_id` |
| `yuxi-runs` | yuxi agent runs：先 POST `/api/chat/thread` 建线程拿 id，再 POST `/api/agent/runs` 建 run，最后 GET `/api/agent/runs/{run_id}/events` 拉 SSE | `thread_id`（首次自动建线程） |
| `openai-compatible` | DeepSeek 等 OpenAI 兼容接口 | 消息历史数组 |

| 字段 | 类型 | 适用 provider | 说明 |
|---|---|---|---|
| `provider` | string | — | 枚举值见上表。 |
| `url` | string | yuxi-chat / yuxi-runs | 服务根地址（yuxi-runs 如 `http://10.10.40.26:4902`）。 |
| `baseUrl` | string | openai | 会拼 `/chat/completions`，如 `https://api.deepseek.com/v1`。 |
| `model` | string | openai | 模型名，如 `deepseek-chat`。 |
| `apiKey` | string | 三个都 | yuxi-chat / yuxi-runs 是鉴权 Bearer token；openai 是 DeepSeek key。 |
| `agentId` | string | yuxi-chat | agent 的 id，拼进 chat URL。 |
| `agentSlug` | string | yuxi-runs | agent 的 slug（如 `agent-45f8f3bdbcf8`）；建线程 body 的 `agent_id` 与 run body 的 `agent_slug` 都用它。 |
| `userId` | string | yuxi-chat | chat 请求里的 `user` 字段（端侧用户标识），缺省用 `external-user-001`。 |
| `timeoutMs` | number | 三个都 | 单次请求超时（ms）。 |

## tts（语音合成：文字 → PCM）

`provider` 二选一：

| provider | 实现 | 流式 |
|---|---|---|
| `cosyvoice-http` | 内网 CosyVoice | 流式：服务端 chunked 推裸 s16le PCM，逐块回调（前端按流式播放） |
| `cosyvoice-ws` | 百炼 CosyVoice | 真流式，每收到一块回调 |

| 字段 | 类型 | 适用 provider | 说明 |
|---|---|---|---|
| `provider` | string | — | 枚举值见上表。 |
| `url` | string | 两个都 | 服务地址。http 档填内网 `http://<host>:50002`，ws 档填百炼 `wss://...`。 |
| `endpoint` | string | http | 拼在 `url` 后面的请求路径。 |
| `apiKey` | string | ws | 百炼 token；为空时回退用 `asr.apiKey`（见 `bailian.js`）。 |
| `model` | string | ws | 百炼 TTS 模型名，如 `cosyvoice-v3-flash`。 |
| `voice` | string | ws | 音色名，如 `longxiaochun_v3`。 |
| `format` | string | ws | 输出音频格式，如 `pcm`。 |
| `spkId` | string | http | 说话人 id（仅 `endpoint` 用 `/inference_sft` 时）。需先用 `scripts/tts-admin.html` 或 `POST /v1/speakers/register` 注册音色。 |
| `promptWav` | string | http | 参考音频路径（`/inference_zero_shot`、`/inference_cross_lingual` 用）。每次合成上传它做音色克隆，如 `server/config/prompt_wav.wav`。 |
| `promptText` | string | http | 参考音频对应的文字（零样本/跨语种克隆用）。CosyVoice3 文本需带 `endofprompt` 标记（token 151646）前缀，缺失会触发模型断言报错。 |
| `sampleRate` | number | 两个都 | 输出 PCM 采样率。 |
| `channels` | number | 两个都 | 输出声道数（1）。 |
| `bitsPerSample` | number | 两个都 | 输出位深（16）。 |
| `timeoutMs` | number | 两个都 | 单次合成超时（ms）。 |

> `sampleRate` / `channels` / `bitsPerSample` 是输出 PCM 参数（裸 s16le 单声道），`/api/tts` 的 `meta` 事件与前端播放器都按它解码，三个档位需保持一致。

---

## 完整示例（脱敏，供 AI 生成时参考）

### local 档

```json
{
  "profile": "local",
  "wakeWords": ["你好小智", "小智小智"],
  "wakeTimeout": 10,
  "vad": { "threshold": 0.55, "startFrames": 3, "endFrames": 15 },
  "server": { "port": 3000, "tmpDir": "/tmp/voiceagent" },
  "asr": {
    "provider": "paraformer-http",
    "url": "http://<asr-host>:50001",
    "endpoint": "/api/v1/asr_stream_file",
    "timeoutMs": 30000
  },
  "llm": {
    "provider": "yuxi-runs",
    "url": "http://<yuxi-host>:4902",
    "apiKey": "<token>",
    "agentSlug": "<agent-slug>",
    "timeoutMs": 120000
  },
  "tts": {
    "provider": "cosyvoice-http",
    "url": "http://<tts-host>:50002",
    "endpoint": "/inference_zero_shot",
    "promptWav": "server/config/prompt_wav.wav",
    "promptText": "You are a helpful assistant.<|endofprompt|>…(参考音频文字)",
    "sampleRate": 24000,
    "channels": 1,
    "bitsPerSample": 16,
    "timeoutMs": 120000
  }
}
```

### online 档

```json
{
  "profile": "online",
  "wakeWords": ["你好小智", "小智小智"],
  "wakeTimeout": 10,
  "vad": { "threshold": 0.55, "startFrames": 3, "endFrames": 15 },
  "server": { "port": 30002, "tmpDir": "/tmp/voiceagent" },
  "asr": {
    "provider": "paraformer-ws",
    "url": "wss://<maas-host>/api-ws/v1/inference",
    "apiKey": "<token>",
    "model": "paraformer-realtime-v2",
    "format": "wav",
    "sampleRate": 16000,
    "timeoutMs": 30000
  },
  "llm": {
    "provider": "openai-compatible",
    "baseUrl": "https://api.deepseek.com/v1",
    "model": "deepseek-chat",
    "apiKey": "<token>",
    "timeoutMs": 60000
  },
  "tts": {
    "provider": "cosyvoice-ws",
    "url": "wss://<maas-host>/api-ws/v1/inference",
    "apiKey": "<token>",
    "model": "cosyvoice-v3-flash",
    "voice": "longxiaochun_v3",
    "format": "pcm",
    "sampleRate": 24000,
    "channels": 1,
    "bitsPerSample": 16,
    "timeoutMs": 60000
  }
}
```
