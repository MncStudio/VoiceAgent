# VoiceAgent 语音代理

浏览器录音 → ASR 识别 → LLM 生成回复 → TTS 合成 → 浏览器播放,一个完整的语音问答闭环。后端在 ASR 之前用 Silero VAD 裁掉首尾静音,只把有效语音送识别。

支持**三路问答**,共享同一份多轮记忆(同一 `sessionId` 内连续问答带上下文):

| 方式 | 接口 | 说明 |
| --- | --- | --- |
| 语音问答 | `POST /api/chat?stream=1` → `WS /api/chat_stream` | 先上传录音识别成文本,再连流式通道问答(两跳) |
| 文字问答 | `WS /api/chat_stream` | 直接发文本,后端一条龙流式 LLM→TTS;`/api/chat_text` 保留给旧消费方 |
| 唤醒词免按键 | `WS /api/wake` | 前端常驻推 16k int16 PCM,命中唤醒词自动回答 |

**流式问答(文字/语音)**:经 `WS /api/chat_stream` 后端一条龙 `LLM 流式增量 → 断句器切句 → 逐句 TTS → 顺序推 PCM`,首句音频不必等整段回复生成完,降低首字延迟。唤醒路保持"回文本 → 前端连 `WS /api/tts` 全篇合成播放"。

## 快速启动

```bash
npm install                 # 只装一次
VA_PROFILE=local npm start  
VA_PROFILE=online npm start 
```

浏览器打开 `http://localhost:3000`(port 取配置 `server.port`,默认 local=3000 / online=30002)。演示页 [public/index.html](public/index.html) 基于 SDK、`autoWake:true` 加载即监听,首次需点击页面授权麦克风(浏览器 autoplay 限制)。

**环境要求**:Node >= 18;系统装有 `ffmpeg`(`audio.js` 转码用)。

**首次 clone 需两步**(均已被 gitignore,仓库里没有):

1. 按 [server/config/README.md](server/config/README.md) 创建 `server/config/{profile}.json`(含 API key,别提交)。
2. 准备 `server/models/silero_vad.onnx`(v5 分发版,官方 snakers4 版局部推理异常)。

无测试/无 lint/无构建,前端 SDK 是无打包的 IIFE。

## 两档配置:local / online

同一套代码,靠 `VA_PROFILE` 环境变量加载 `server/config/{profile}.json`(默认 `local`)。**每个环节(asr/llm/tts)各自用 `provider` 字段选实现,不强绑档位**,可随意混搭。

| 环节 | `local` | `online` |
| --- | --- | --- |
| **ASR** | 内网 Paraformer HTTP | 阿里云百炼 Paraformer WS |
| **TTS** | 内网 CosyVoice HTTP(`spkId` 引用音色) | 百炼 CosyVoice WS(`voice` 音色) |
| **LLM** | DeepSeek(OpenAI 兼容) | DeepSeek(OpenAI 兼容) |
| **网络** | ASR/TTS 走内网,LLM 连 DeepSeek | 全走阿里云百炼 + DeepSeek |
| **费用** | ASR/TTS 自建免费,LLM 按量 | 全部按量计费 |

> 上表为当前两档默认值。真实端点 / 音色 / 密钥在 gitignore 的 `server/config/local.json` / `online.json`;想用人设 Agent 就把 `llm.provider` 设为 `yuxi-chat`(语析 openapi chat)。字段说明见 [server/config/README.md](server/config/README.md)。

## 目录结构

```text
server/
├── index.js     # Express 入口 + /api/chat + /api/chat_text + 共享 WebSocketServer(/api/wake、/api/tts)
├── config.js    # 按 VA_PROFILE 加载 server/config/{profile}.json,缺文件直接抛错
├── config/      # 两套配置(含 key,gitignore 不入库;字段说明见 config/README.md)
├── audio.js     # ffmpeg 转码(webm → 16k mono wav)、临时文件清理
├── vad.js       # Silero VAD 静音裁剪(onnxruntime-node 推理)+ 流式 VAD
├── models/      # silero_vad.onnx 模型文件
├── asr.js       # 音频 → 文字(local HTTP / 百炼 WS 分流)
├── llm.js       # 文字 → 回复(openai-compatible / yuxi-chat 分流,多轮记忆)
├── tts.js       # 回复 → PCM 流(local HTTP / 百炼 WS 分流)
├── wake.js      # 流式开口段检测 + 唤醒词匹配(拼音模糊)+ 自动回答
├── turn.js      # 会话表(sessionId → 多轮上下文,三路共用)
├── timing.js    # 链路耗时打点(Timing→mark→log)
└── bailian.js   # 阿里云百炼 WebSocket 客户端(ASR + TTS)

public/
├── voice-agent.js  # 前端 SDK(VoiceAgent 类,一个入口封装三路问答 + 自动 TTS 播放)
└── index.html      # 接口演示页(只调 SDK 的 UI 示例)
```

## 相关文档

- [docs/API.md](docs/API.md) — 接入文档(SDK 用法 + 后端接口协议 + 跨域部署)
- [server/config/README.md](server/config/README.md) — 配置字段说明(local / online 两档完整示例)
