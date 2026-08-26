# VoiceAgent「小宠物」形象开发规格

> 目标：给 VoiceAgent 的浏览器页面加一个「浮动小宠物」作为 AI 形象（类似桌面宠物）。平时在角落做 idle 小动作（眨眼、左右张望、微微呼吸/浮动），语音问答时嘴巴跟着说话开合、身体轻弹，声音停止回 idle。
> 不追求逼真，只追求「它活了」。**不依赖外部图片/模型，纯前端程序绘制，自包含可运行。**

## 一、项目现状（真实接入点）

项目根：`/Users/mnc/Documents/VoiceAgent`（Node/Express 后端 + 原生前端 IIFE SDK）

前端 SDK `public/voice-agent.js`，无构建。核心结构：

- `TtsPlayer`（`VoiceAgent` 里 `this._tts`），负责播放 TTS 音频：
  - `this._audioCtx`：一个 `AudioContext`（sampleRate 24000）
  - `this._out`：音频汇流目标节点，每个 `AudioBufferSourceNode` 都连到 `_out`（约第 69 行）
  - `this._playing`：是否正在播放，由 `_setPlaying(v)` 维护（约第 84 行）
  - `onReplyDelta(text)`：流式字幕增量回调（约第 148 行）
  - `onDone(replyText)`：回答完成回调（约第 118 / 150 行）
  - `stop()`：停止播放（约第 89 行）
- `VoiceAgent`：`this._tts = new TtsPlayer(this.baseUrl)`

演示页：`public/index.html`

**约束**：不改后端接口；不加构建、不引 npm/框架、不引入外部依赖；作为可拔插的独立组件加进来，改动最小化。

## 二、需求（行为）

1. 一个小角色（默认约 96–128px），定位页面右下角/底部，`position: fixed` 浮在上层，尽量不挡交互。
2. **Idle**（未说话）：眨眼、呼吸/上下浮动、偶尔左右张望或随机小动作（转头/跳一下/挥手/发呆）。
3. **说话**（TTS 正在播放）：嘴开合，身体随音频轻弹；声音停回 idle。
4. **嘴型**：优先用**实时音频振幅**驱动嘴巴张开幅度；拿不到振幅就退化为固定频率开合。
5. **外观可参数化**：颜色/体型/眼睛/嘴形可配置；默认给一只可爱小生物（圆胖幽灵/猫/方块生物都行），用 SVG 或 Canvas 绘制。

## 三、推荐技术方案

- 独立模块 `public/voice-pet.js`，暴露 `window.VoicePet`：`new VoicePet({ container, size, palette, ... })`。
- 提供 `setSpeaking(bool)`、`start()`/`stop()` 接口；内部用 `requestAnimationFrame` 驱动一个小的状态机（idle / talking）。
  - **建议让 pet 独立，`VoiceAgent` 只发状态变化，两者解耦。**
- **与 TTS 怎么接（关键）**：
  - On/off：在 `TtsPlayer` 的 `_setPlaying(v)` 变化时（或 `onReplyDelta` 首个增量 → speaking on，`onDone` → speaking off）通知 pet。可以给 `TtsPlayer` 加一个 `onStateChange(speaking)` 回调，或在 SDK 内拿到 `_tts._playing` 去驱动 pet。
  - 振幅：在 `TtsPlayer` 的音频图上，让每个源经过一个 **`AnalyserNode`** 再连到 `_out`（或对 `_out` 打点），pet 用 `requestAnimationFrame` 读 `getByteTimeDomainData` 求音量 → 映射嘴开合/身体弹动。
- 动画用 rAF 循环；纯 CSS 硬循环仅作为 fallback。

## 四、验收

- `VA_PROFILE=local npm start` 后打开 `http://localhost:3000`，右下出现小宠物，自动 idle 动画。
- 发起一次语音/文字问答，回答播放时宠物进入「说话」（嘴动+身体弹），回答结束回 idle。
- 无 console 报错；不影响现有录音、唤醒、打断功能；无新增构建/依赖。

## 五、交付

- `public/voice-pet.js`（宠物模块）
- `public/index.html` 里加挂载代码
- `public/voice-agent.js` 里加 pet 联动（`_setPlaying` / 振幅 hooks），改动最小
- 说明：是否常驻显示、大小/位置等可配置项
