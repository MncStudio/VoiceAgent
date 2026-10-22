# 超宝 · 浏览器数字人语音助手

按照《数字人语音助手.md》落地的可运行项目，默认唤醒词 **你好超宝**（`.env` 的 `WAKE_WORD` 可改，本地唤醒拼音自动生成，重启服务并刷新页面生效）。默认使用无需密钥的文本演示模式。线上模式请自行创建 `.env` 并配置百炼密钥；密钥仅由服务端读取，不要分享或提交。

## 启动

Windows 在项目目录运行：

```powershell
.\启动超宝.ps1
```

打开 <http://127.0.0.1:5173/>，使用 Chrome / Edge。点击“连接麦克风”并允许麦克风权限。等待设置中的本地唤醒、Silero VAD、降噪加载完成，再说“你好超宝，介绍一下你自己”。首次加载端侧模型可能需要几秒；可先用“点按唤醒”或文字聊天。

局域网其他设备可直接打开 `http://本机IP:5173/`（前端、超宝服务、LiveKit 默认都监听 0.0.0.0，不限制网页来源）。要在局域网用语音，`.env` 的 `LIVEKIT_URL` 需改为 `ws://本机IP:7880`，并放行防火墙 5173、7880、7881/TCP、7882/UDP；浏览器只在 localhost 或 HTTPS 页面开放麦克风，局域网 HTTP 页面需配 HTTPS（或临时用 Chrome 的 `unsafely-treat-insecure-origin-as-secure`）。

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

- React + TypeScript 沉浸式语音舞台：数字形象居中，光环与配色随六种对话状态变化（待命 / 聆听 / 思考 / 回答 / 打断），舞台字幕实时显示转写和正在播报的内容；底部控制坞为麦克风开关、可点按唤醒的主按钮（外圈显示追问倒计时、内部随音量跳动）和停止按钮；对话记录为可收起侧栏（手机端在舞台下方）；设置中查看模型状态与首音频延迟。
- 唤醒应答：每次唤醒（语音或点按）都先应答“我在”（`WAKE_ACK`，预合成缓存、零等待）；唤醒词后直接接命令时等用户说完再应答，回答排在应答之后播放；应答的回声不会混入识别结果。
- 回答中再次唤醒：思考或播报时再说唤醒词，本地唤醒一命中就立即停止当前回答（浏览器本地先静音），被打断的问题和半句回答整轮移出上下文、不再回答；复核通过后应答“我在”（`REWAKE_ACK`，留空沿用 `WAKE_ACK`）等用户继续提问，唤醒词后直接接新问题则应答后回答新问题；复核没通过时回答已停，打开追问窗口可直接说话。点按唤醒打断同样处理。免唤醒打断先停了回答、随后才认出唤醒词时同样按再次唤醒处理，晚到的本地唤醒不会重复复核。
- 每次提问都要先唤醒（`WAKE_REQUIRED=true`，默认）：回答结束直接待命，不开免唤醒追问窗口；回答中只有唤醒词、点按、“别说了 / 暂停”能打断，本人直接开口不打断。设为 `false` 恢复下面的连续对话行为。
- （`WAKE_REQUIRED=false` 时）回答中本人开口（已锁定声纹且声纹一致）：播报和思考阶段都会先识别再判断——含唤醒词按再次唤醒处理（停止并应答“我在”）；只是“嗯 / 好”等附和则忽略、继续回答；其他内容当作提问。思考阶段开口说新内容时丢掉刚才的问题（也移出上下文），只回答新说的话。声纹不一致不会打断；“别说了 / 暂停”在思考和播报阶段都能立即停止。
- 说一半想一想不抢答：句子明显没说完（只有动词如“帮我查询”“我想查一下”“打开”，或句尾是“还有 / 如果 / 帮我 / 一个”等）时，停顿 `INCOMPLETE_PAUSE_MS`（默认 3 秒）才当作说完，期间接着说会并入同一句；“把灯打开”“帮我查询库存”这类已带宾语的照常快速断句。
- three.js / three-vrm 渲染用户导入的 `.vrm` 文件，浏览器内读取；呼吸、眨眼、倾听姿态和音频能量口型。没有 VRM 时使用默认动态形象。
- `getUserMedia` AEC / NS / AGC；AudioWorklet 16kHz PCM 采集；RNNoise 仅用于本地唤醒链路；Silero VAD 本地运行；不开启摄像头。
- sherpa-onnx WASM Web Worker 连续检测“你好超宝 / 别说了 / 暂停 / 下一个”；一级候选视觉反馈，服务端以缓冲音频的 ASR 转写复核（按拼音音节匹配，容忍同音/近音字与 zh/z、l/n、an/ang 等口音差异）；本地已命中时复核再容忍一个音节听错或漏字（如“好超宝”，但“超宝”两字必须对上）；确认后提示音；失败自动恢复，服务端日志 `[wake]` 会打印复核未通过时的识别结果；没唤醒时（一级没触发）也会单独识别这句话并打印“`[wake] 待机时未唤醒，听到：“…”`”，含唤醒词或只差一个音节时注明“端侧唤醒没命中”，便于区分“一级没触发”“复核没通过”还是“根本听错了”（`WAKE_MISS_LOG=false` 关闭，开启时待机说话也会产生识别用量）。一级灵敏度由 `KWS_THRESHOLD` / `KWS_BOOST` 调节，并内置“nǐ→ní”变调写法；`KWS_DENOISE=false` 可关闭唤醒链路的 RNNoise 叠加。采集重采样使用带抗混叠低通的 FIR 抽取。“别说了 / 暂停”等命令词只在播报或思考时生效，且与当前播报内容重合时视为回声忽略。
- LiveKit WebRTC 双向音频：麦克风上行，服务端将 CosyVoice PCM 发布为远端音轨。浏览器使用原生 HTMLAudioElement 播放，保留浏览器回声参考路径。
- ASR / LLM / TTS 接口抽象；百炼 Paraformer / OpenAI 兼容 Qwen SSE / CosyVoice 双向 WebSocket；本地 FunASR 2pass / OpenAI 兼容 Qwen / CosyVoice HTTP 适配器；可显式切换的无密钥文本演示模式。
- 3 秒服务端音频环形缓冲，回放起点按 VAD 开口时刻计算（开口前 400ms），追问、打断都不截句首；一句话直达。
- 百炼 ASR / TTS WebSocket 预连接池（VAD 起始即预热），TTS 首段遇逗号尽早切出、后续整句切分，最多 2 段并发预合成、按顺序播放，句间无等待间隙；AbortController 取消、清空服务端音频队列、浏览器立即静音、失效请求结果隔离。
- `TURN_MODEL` 可选小 LLM 语义断句与追问非对话拒识；超时有明确降级路径。可设置 `TURN_MODEL=qwen-plus` 启用 Qwen 语义判断。停顿 200ms 后可投机请求 LLM，确认后复用，用户继续说话立即取消，未确认内容不展示/播报；`SPECULATIVE=false` 可关闭以减少额度消耗。
- CAM++ 本地 embedding 与唤醒后声纹锁定，余弦比对、跟随追问门控、附和词判断、降低播报音量后再判断打断；异步声纹结果不会覆盖较新的 VAD 状态。
- 8 秒连续对话窗口；追问窗口内一开口就开始识别，不等声纹确认；已锁定声纹时用整句声纹判断，只有足够长（≥1s）且明显不像本人（低于 `SPEAKER_THRESHOLD - 0.15`）的话才忽略，短句和边缘分数一律放行；窗口到期不会打断正在说的追问，播报残余回声不会被当成追问。追问判断超时默认作答。免唤醒打断确认后沿用同一路识别流，不重开连接、不丢字。
- 声纹 fbank 与 Kaldi/CAM++ 训练特征对齐；只用开口后的音频比对，阈值 `SPEAKER_THRESHOLD` 可调。
- 控制连接或 LiveKit 断开时自动指数退避重连并恢复语音；会话仅在无连接 5 分钟后回收，不再定时强制断开。会话记忆仅保存在该会话的服务端内存，清空或断开后删除。
- 参数校验、消息频率限制、会话数限制、空闲会话回收、固定本地来源校验、原生资源清理和服务健康检查。默认不落盘真实麦克风录音。

## 需要继续实测与补齐的方案项

这是一套已接通真实模型和音频的开发基线，**尚未完成方案的生产性能验收**。不能把功能联通等同于 3 米/5dB 的 95% 唤醒率或 24 小时低误唤醒率。

| 方案项         | 当前状态与边界                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 一级唤醒       | 使用官方通用中文模型，默认固定四音节关键词；改 `.env` 中的文字名称不会自动训练新词，还需同步 `web/src/audio.ts` 的拼音 token 配置。        |
| 二级复核       | 已实现独立 ASR 转写复核；额外大尺寸 KWS 和噪声自适应阈值尚待接入、标定。                                                                   |
| 断句           | 已接入 VAD + 小 LLM 完整度判断、200ms 停顿投机请求；不完整句最多等待 1.5s。未配置语义模型时使用 450ms/1.5s 规则，不是微调后的 smart-turn。 |
| 免唤醒打断     | 已接入目标声纹比对、降音量与 ASR 内容判定；由于需积累足够声纹片段，不能承诺 150ms；需针对真实环境标定阈值。                                |
| 多人环境       | 当前进行目标说话人门控，不是语音分离；重叠说话无法保证提取出干净的目标语音，需多人/电视背景实测。                                          |
| 播放位置与口型 | PCM 时长估算字级时间戳，音量驱动口型；打断历史按客户端估算的已播字数截断。真实字级强制对齐、精确口型和声学播放回执待接入。                 |
| 语义能力       | 已接通 Qwen 对话、投机请求和可配置的追问拒识；专门训练的非对话拒识模型、业务工具调用和长期记忆待数据/业务明确后扩展。                      |
| 表情/音色      | 支持导入 VRM 与能量口型；ARKit 52、情感标签、参考音色克隆和专属人物资产尚未配置。                                                          |
| 唤醒训练与验收 | 需真实录音数据、噪声/距离/设备测试集和持续负样本；本项目未虚构训练或验收数据。                                                             |

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

### 接入 Yuxi 问答

问答后端可独立切换，保留 `PROVIDER=dashscope` 的百炼语音识别和合成。在 `.env` 设置：

```dotenv
QA_PROVIDER=yuxi
YUXI_BASE_URL=http://8.130.55.151:5050
YUXI_API_KEY=填写专用接口密钥
YUXI_AGENT_SLUG=wms
```

当前服务器的 `wms` 是“储运一体化平台智能体”，配置了企业知识库和 WMS MCP。接口密钥只保存在服务端 `.env`，不会返回网页；SSH 登录信息不用于运行时问答。设置 `QA_PROVIDER=openai` 可切回原来的 `LLM_BASE_URL` / `LLM_MODEL`。

适配器调用 Yuxi 的线程、运行和 SSE 事件接口，仅将正文增量交给字幕和 TTS。每次回答携带本地会话上下文并创建临时线程，完成后删除；打断时先请求取消远程运行，再清理线程。清理失败会记录不含密钥的日志。清空本地对话后不再携带旧上下文；Yuxi 自身的审计和运行日志仍遵循服务器的保留策略。

Yuxi 模式关闭投机问答，避免在用户尚未说完时触发业务工具；`TURN_MODEL` 的语义断句仍走原有 OpenAI 兼容模型配置。单次业务问答最多等待 120 秒。

生产构建：

```powershell
npm run build
npm start
```

服务端同时托管 `dist/web`，访问 3001。远程部署还需 HTTPS、反向代理认证、非开发 LiveKit 密钥、可访问的 ICE/TURN 和实际允许的域名配置；现有配置用于本机开发，没有配置公网多用户认证。模型资源打包在本地输出内，构建目录体积较大。

## 在其他项目中接入（SDK）

其他系统想用超宝、但界面自己做时，使用 SDK：唤醒、VAD、声纹、降噪、LiveKit 音频与对话协议都在 SDK 里，宿主页面只负责界面。

1. 超宝服务执行 `npm run build`（或单独 `npm run build:sdk`）后，在 `/sdk/chaobao-sdk.js` 提供 SDK，类型声明在 `/sdk/chaobao-sdk.d.ts`（源文件 `sdk/chaobao-sdk.d.ts`）。开发启动 `npm run dev` / `npm run dev:server` 会自动先构建 SDK。端侧模型、Worker、AudioWorklet 仍由超宝服务按 `baseUrl` 提供，不需要拷贝到宿主项目；超宝升级后宿主无需重新构建。
   超宝不限制网页来源，宿主页面无需加白名单。
2. 宿主页面运行时加载：

   ```js
   const { ChaobaoAssistant } = await import(/* @vite-ignore */ '/chaobao/sdk/chaobao-sdk.js');
   const bot = new ChaobaoAssistant({ baseUrl: '/chaobao', rememberVoice: true });
   bot.on('state', ({ state }) => {}); // IDLE / CANDIDATE / LISTENING / THINKING / SPEAKING / INTERRUPT
   bot.on('messages', (list) => {}); // 对话记录快照
   bot.on('transcript', ({ text, final }) => {}); // 实时转写
   bot.on('level', (v) => {}); // 播报音量 0~1，驱动口型
   bot.on('error', (msg) => {});
   await bot.init(); // 读取服务端配置
   button.onclick = () => bot.enableVoice(); // 开麦需在用户点击中调用
   bot.wake();
   bot.sendText('你好');
   bot.stop();
   bot.reset();
   bot.destroy();
   ```

3. 地址二选一：
   - **推荐：同源反向代理**。宿主的 Vite / Nginx 把 `/chaobao/` 转发到超宝服务（去掉前缀，需支持 WebSocket），`baseUrl: '/chaobao'`。无跨域问题，HTTPS 只需在宿主一处配置。
   - 跨域直连：`baseUrl: 'https://chaobao.example.com'`，超宝对任意来源返回 CORS 头，KWS Worker 会自动经 Blob 中转加载。
4. 无论哪种方式，`LIVEKIT_URL` 必须是用户浏览器能访问的地址（HTTPS 页面用 `wss://`）；页面必须是 HTTPS 或 localhost，否则浏览器不给麦克风。
5. 一个页面只创建一个实例（SDK 内部按全局服务地址工作）。选煤系统的 Vue 接入示例见该项目 `src/components/ChaobaoAssistant`。

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
web/src/            页面、音频处理、声纹与 VRM 渲染；sdk.ts 为对外 SDK 入口
sdk/                SDK 类型声明（构建产物在 dist/sdk）
web/public/         AudioWorklet、KWS Worker、本地模型
scripts/            资源下载、服务启动与接口诊断
tests/              编排单元回归与浏览器集成测试
```

官方接口与模型来源：[LiveKit 原始音轨](https://docs.livekit.io/transport/media/raw-tracks/)、[百炼 CosyVoice WebSocket](https://help.aliyun.com/zh/model-studio/cosyvoice-websocket-api)、[sherpa-onnx 唤醒模型](https://k2-fsa.github.io/sherpa/onnx/kws/index.html)、[官方 sherpa-onnx WebAssembly 包](https://pub.dev/packages/sherpa_onnx_web)、[CAM++ 模型](https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models)。具体部署模型的许可证应以其权重与附带说明为准。

### 宿主已有业务问答（流式 TTS）

SDK 可使用 `new ChaobaoAssistant({ baseUrl: '/voice-api', external: true })`。
监听 `question` 事件取得 `{ turnId, text }`，将问题送入宿主原有业务接口；每次收到正文增量，清理 Markdown/HTML 排版后调用 `bot.appendAnswer(turnId, plainText)`，接口完成时调用 `bot.appendAnswer(turnId, '', true)`。
此模式不再调用 VoiceAgent 自己的业务 LLM，也不开启投机问答。正文到达后沿用两段并发预合成与顺序播放，可在业务 SSE 结束前开始朗读。

宿主暂停按钮应同时取消业务请求并调用 `bot.stop()`；监听原始 `event` 中的 `interrupted` 也应取消宿主请求，覆盖语音打断的情况。暂停后的旧 turnId 增量被丢弃。宿主流最长等待 120 秒、每轮纯文本最多 20000 字，最后一包应明确 `done=true`。

digital-employee 的具体接入与 Live2D 替换说明见该项目 `docs/voice-integration.md`。
