# VoiceAgent 语音代理

浏览器录音 → ASR 识别 → LLM 生成回复 → TTS 合成 → 浏览器播放,一个完整的语音问答闭环。后端在 ASR 之前用 Silero VAD 裁掉首尾静音,只把有效语音送识别。

## 两套配置:local / online

同一套代码,通过 `VA_PROFILE` 环境变量切换后端服务(默认 `local`,不设也走 local)。

| | `local`(本地 192) | `online`(全线上) |
|---|---|---|
| **ASR 识别** | 内网 Paraformer HTTP<br>`192.168.110.247:50001` | 阿里云百炼 WebSocket<br>`paraformer-realtime-v2` |
| **LLM 对话** | 语析 Yuxi(带"仕行智库"人设)<br>`192.168.110.139:5050` | DeepSeek(OpenAI 兼容)<br>`deepseek-chat` |
| **TTS 合成** | 内网 CosyVoice HTTP<br>`192.168.110.247:50002`,音色 `assistant_voice` | 百炼 WebSocket<br>`cosyvoice-v3-flash`,音色 `longxiaochun_v3` |
| **网络依赖** | 仅内网可达,不出公网 | 需要连阿里云 + DeepSeek |
| **费用** | 自建服务,免费 | 按量计费 |
| **多人设** | 有(仕行智库) | 无(DeepSeek 是通用助手) |

**怎么选:**
- 内网服务在、人设重要 → `VA_PROFILE=local npm start`
- 想用 DeepSeek、不怕连云 → `VA_PROFILE=online npm start`(默认不设也走 local)

两套多轮记忆都支持(local 用语析 threadId,online 用 DeepSeek 消息历史),代码完全一致,只换配置。

## 启动

```bash
npm install
VA_PROFILE=local npm start    # 或 VA_PROFILE=online
```

然后浏览器打开 http://localhost:3000,按住录音按钮提问。

## 目录结构

```
server/
├── index.js     # Express 入口 + POST /api/chat + 静态托管 + 会话表
├── config.js    # 加载 server/config/{profile}.json
├── config/      # 两套配置(含 key,已 gitignore 不入库)
├── audio.js     # ffmpeg 转码(webm → wav)、临时文件清理
├── vad.js       # Silero VAD 静音裁剪(onnxruntime-node 推理)
├── models/      # silero_vad.onnx 模型文件
├── asr.js       # 音频 → 文字(本地 HTTP / 百炼 WS 分流)
├── llm.js       # 文字 → 回复(语析 agent / DeepSeek 分流,多轮记忆)
├── tts.js       # 回复 → wav 音频(本地 HTTP / 百炼 WS 分流)
└── bailian.js   # 阿里云百炼 WebSocket 客户端(ASR + TTS)
```

## 相关文档

- [技术方案.md](技术方案.md) — 架构设计
- [接口对接文档.md](接口对接文档.md) — 三个模型服务的接口实测
