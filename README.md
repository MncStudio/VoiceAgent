# 超宝 · 浏览器数字人语音助手

按照《数字人语音助手.md》落地的可运行项目，默认唤醒词 **你好超宝**。默认使用无需密钥的文本演示模式。线上模式请自行创建 `.env` 并配置百炼密钥；密钥仅由服务端读取，不要分享或提交。

## 启动

Windows 在项目目录运行：

```powershell
.\启动超宝.ps1
```

打开 <http://127.0.0.1:5173/>，使用 Chrome / Edge。点击“连接麦克风”并允许麦克风权限。等待设置中的本地唤醒、Silero VAD、降噪加载完成，再说“你好超宝，介绍一下你自己”。首次加载端侧模型可能需要几秒；可先用“点按唤醒”或文字聊天。

也可以分别启动两个终端：

```powershell
npm run livekit
```

```powershell
npm run dev
```

文本对话不需要 LiveKit。语音会话需要三个进程：Vite（5173）、Agent HTTP 服务（3001）、LiveKit（7880 / 7881 / 7882 UDP）。原生 Windows LiveKit 会提示不支持 CPU 容量监控，但可以正常运行。开发模式默认只监听本机。

## 新机器安装

需要 Node.js 22+、npm、curl、tar。推荐 Node.js 22 的最新补丁版本或 24 LTS。

```powershell
npm ci
Copy-Item .env.example .env
npm run setup:assets -- --speaker
npm run setup:livekit
```

在 `.env` 设置 `PROVIDER=dashscope` 和 `DASHSCOPE_API_KEY`。部署到服务器时可用 `docker compose up -d livekit` 替代原生 LiveKit。

`setup:assets` 将官方 RNNoise、Silero VAD、ONNX Runtime、sherpa-onnx WebAssembly 和中文唤醒模型下载/复制到 `web/public`；`--speaker` 另下载 CAM++。运行期间全部端侧模型从本机加载，无需公共 CDN。下载脚本支持标准 `https_proxy` / `HTTPS_PROXY`；无代理时直接连接。模型下载失败会保留可见错误，不会悄悄启用浏览器在线语音识别。

## 已实现

- React + TypeScript 浏览器界面；默认动态数字形象、六种对话状态、用户实时转写、助手流式字幕、响应式布局、错误提示、设置与模型状态。
- three.js / three-vrm 渲染用户导入的 `.vrm` 文件，浏览器内读取；呼吸、眨眼、倾听姿态和音频能量口型。没有 VRM 时使用默认动态形象。
- `getUserMedia` AEC / NS / AGC；AudioWorklet 16kHz PCM 采集；RNNoise 仅用于本地唤醒链路；Silero VAD 本地运行；不开启摄像头。
- sherpa-onnx WASM Web Worker 连续检测“你好超宝 / 别说了 / 暂停 / 下一个”；一级候选视觉反馈，服务端以缓冲音频的 Paraformer 转写复核；确认后提示音；失败自动恢复。
- LiveKit WebRTC 双向音频：麦克风上行，服务端将 CosyVoice PCM 发布为远端音轨。浏览器使用原生 HTMLAudioElement 播放，保留浏览器回声参考路径。
- ASR / LLM / TTS 接口抽象；百炼 Paraformer / OpenAI 兼容 Qwen SSE / CosyVoice 双向 WebSocket；本地 FunASR 2pass / OpenAI 兼容 Qwen / CosyVoice HTTP 适配器；可显式切换的无密钥文本演示模式。
- 3 秒服务端音频环形缓冲、一句话直达、按句并发合成、AbortController 取消、清空服务端音频队列、浏览器立即静音、失效请求结果隔离。
- `TURN_MODEL` 可选小 LLM 语义断句与追问非对话拒识；超时有明确降级路径。可设置 `TURN_MODEL=qwen-plus` 启用 Qwen 语义判断。停顿 200ms 后可投机请求 LLM，确认后复用，用户继续说话立即取消，未确认内容不展示/播报；`SPECULATIVE=false` 可关闭以减少额度消耗。
- CAM++ 本地 embedding 与唤醒后声纹锁定，余弦比对、跟随追问门控、附和词判断、降低播报音量后再判断打断；异步声纹结果不会覆盖较新的 VAD 状态。
- 8 秒连续对话窗口；只有已锁定且匹配的声纹能够自动触发；没有可靠锁定时可继续点按。会话记忆仅保存在该会话的服务端内存，清空或断开后删除。
- 参数校验、消息频率限制、会话数/时长限制、固定本地来源校验、原生资源清理和服务健康检查。默认不落盘真实麦克风录音。

## 需要继续实测与补齐的方案项

这是一套已接通真实模型和音频的开发基线，**尚未完成方案的生产性能验收**。不能把功能联通等同于 3 米/5dB 的 95% 唤醒率或 24 小时低误唤醒率。

| 方案项 | 当前状态与边界 |
| --- | --- |
| 一级唤醒 | 使用官方通用中文模型，默认固定四音节关键词；改 `.env` 中的文字名称不会自动训练新词，还需同步 `web/src/audio.ts` 的拼音 token 配置。 |
| 二级复核 | 已实现独立 ASR 转写复核；额外大尺寸 KWS 和噪声自适应阈值尚待接入、标定。 |
| 断句 | 已接入 VAD + 小 LLM 完整度判断、200ms 停顿投机请求；不完整句最多等待 1.5s。未配置语义模型时使用 450ms/1.5s 规则，不是微调后的 smart-turn。 |
| 免唤醒打断 | 已接入目标声纹比对、降音量与 ASR 内容判定；由于需积累足够声纹片段，不能承诺 150ms；需针对真实环境标定阈值。 |
| 多人环境 | 当前进行目标说话人门控，不是语音分离；重叠说话无法保证提取出干净的目标语音，需多人/电视背景实测。 |
| 播放位置与口型 | PCM 时长估算字级时间戳，音量驱动口型；打断历史按客户端估算的已播字数截断。真实字级强制对齐、精确口型和声学播放回执待接入。 |
| 语义能力 | 已接通 Qwen 对话、投机请求和可配置的追问拒识；专门训练的非对话拒识模型、业务工具调用和长期记忆待数据/业务明确后扩展。 |
| 表情/音色 | 支持导入 VRM 与能量口型；ARKit 52、情感标签、参考音色克隆和专属人物资产尚未配置。 |
| 唤醒训练与验收 | 需真实录音数据、噪声/距离/设备测试集和持续负样本；本项目未虚构训练或验收数据。 |

## 配置与本地化

统一配置位于 `.env`，完整字段见 `.env.example`。百炼地域必须与密钥一致；如使用工作空间专属域名，将 `DASHSCOPE_WS_URL` 和 `LLM_BASE_URL` 换成控制台对应地址。开发期已使用默认北京兼容域名完成接口验证。

```dotenv
PROVIDER=local
LLM_BASE_URL=http://127.0.0.1:8000/v1
LLM_MODEL=Qwen3
LOCAL_LLM_API_KEY=local
LOCAL_ASR_URL=ws://127.0.0.1:10095
LOCAL_TTS_URL=http://127.0.0.1:50000/inference_sft
LOCAL_TTS_VOICE=中文女
```

本地模型服务需自行启动：ASR 接收 FunASR 官方 2pass PCM WebSocket 协议；LLM 提供 OpenAI 兼容 `/chat/completions` SSE；TTS 接收 `tts_text` / `spk_id` 表单并输出 **24kHz、int16 LE、单声道裸 PCM**。CosyVoice 各版本原生采样率可能不同，请在网关统一重采样后再对接，不能把 WAV / MP3 文件头当 PCM。

生产构建：

```powershell
npm run build
npm start
```

服务端同时托管 `dist/web`，访问 3001。远程部署还需 HTTPS、反向代理认证、非开发 LiveKit 密钥、可访问的 ICE/TURN 和实际允许的域名配置；现有配置用于本机开发，没有配置公网多用户认证。模型资源打包在本地输出内，构建目录体积较大。

## 验证

```powershell
npm run check
npm test
npx playwright install chromium
npm run test:e2e
npm run doctor
```

`doctor` 会使用当前配置实际调用 LLM、TTS、ASR，会消耗少量模型额度。它只输出成功与错误状态，不打印密钥；合成音频测试素材位于被忽略的 `.runtime`。

语音完整集成测试使用合成的麦克风输入，不访问真实麦克风：

```powershell
npx tsx scripts/voice-fixture.ts
$env:VOICE_INTEGRATION='1'
npx playwright test tests/e2e/voice.spec.ts
```

该测试需要已运行的 LiveKit 和开发服务；检测本地 KWS/VAD/CAM++ 加载、真实唤醒、真实 ASR/LLM 回复及 WebRTC 下行非零音频。它不能替代真实房间中的 AEC、噪声、多人和远场验收。截图在 `.runtime`。

## 目录

```text
server/             会话编排、HTTP/控制连接、LiveKit 音轨
server/providers/   线上/本地 ASR、LLM、TTS Provider
shared/             带运行时校验的事件协议
web/src/            页面、音频处理、声纹与 VRM 渲染
web/public/         AudioWorklet、KWS Worker、本地模型
scripts/            资源下载、服务启动与接口诊断
tests/              编排单元回归与浏览器集成测试
```

官方接口与模型来源：[LiveKit 原始音轨](https://docs.livekit.io/transport/media/raw-tracks/)、[百炼 CosyVoice WebSocket](https://help.aliyun.com/zh/model-studio/cosyvoice-websocket-api)、[sherpa-onnx 唤醒模型](https://k2-fsa.github.io/sherpa/onnx/kws/index.html)、[官方 sherpa-onnx WebAssembly 包](https://pub.dev/packages/sherpa_onnx_web)、[CAM++ 模型](https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models)。具体部署模型的许可证应以其权重与附带说明为准。
