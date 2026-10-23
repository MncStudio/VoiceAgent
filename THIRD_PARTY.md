# 第三方资源来源

运行代码的精确 npm 版本由 `package-lock.json` 固定。原始许可证保留在各 npm 包及下载资源中，项目未重新授权第三方权重。

| 组件                                             | 官方来源                                                                        | 用途                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| LiveKit                                          | https://github.com/livekit/livekit                                              | 本机 WebRTC SFU，固定 1.9.12                                             |
| LiveKit Node / JS SDK                            | https://github.com/livekit/node-sdks / https://github.com/livekit/client-sdk-js | 原生服务端音轨 / 浏览器音轨                                              |
| sherpa-onnx                                      | https://github.com/k2-fsa/sherpa-onnx                                           | KWS，官方 `sherpa_onnx_web 1.13.8` WASM 包                               |
| 中文 KWS                                         | https://github.com/k2-fsa/sherpa-onnx/releases/tag/kws-models                   | `sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01`                  |
| CAM++                                            | https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models   | `3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx`                     |
| Silero VAD                                       | https://github.com/snakers4/silero-vad                                          | 本地语音活动检测                                                         |
| vad-web                                          | https://github.com/ricky0123/vad                                                | 浏览器 VAD 与工作线程集成                                                |
| RNNoise wrapper                                  | https://github.com/sapphi-red/web-noise-suppressor                              | 本地 RNNoise AudioWorklet                                                |
| ONNX Runtime                                     | https://github.com/microsoft/onnxruntime                                        | VAD / CAM++ 浏览器推理                                                   |
| three.js / three-vrm                             | https://github.com/mrdoob/three.js / https://github.com/pixiv/three-vrm         | VRM 渲染与表情驱动                                                       |
| Spine Runtimes（spine-player / spine-webgl 4.3） | https://github.com/EsotericSoftware/spine-runtimes                              | 默认 Spine 形象渲染；Spine Runtimes License，商用需持有 Spine 编辑器授权 |

默认形象“猫耳电视机器人”为使用方提供的 Spine 4.3 资源（`web/public/avatar/cat-tv-robot/`），其美术版权与使用授权由提供方负责；加载失败时的兜底机器人由项目内 CSS 绘制。自行导入的 VRM、后续克隆音色与训练音频需要由使用方提供相应使用授权。
