import 'dotenv/config';
import { z } from 'zod';
const schema = z.object({
  PROVIDER: z.enum(['demo', 'dashscope', 'local']).default('demo'),
  DASHSCOPE_API_KEY: z.string().default(''),
  DASHSCOPE_WS_URL: z.url().default('wss://dashscope.aliyuncs.com/api-ws/v1/inference'),
  LLM_BASE_URL: z.url().default('https://dashscope.aliyuncs.com/compatible-mode/v1'),
  LLM_MODEL: z.string().default('qwen-plus'),
  QA_PROVIDER: z.enum(['openai', 'yuxi']).default('openai'),
  YUXI_BASE_URL: z.url().default('http://127.0.0.1:5050'),
  YUXI_API_KEY: z.string().default(''),
  YUXI_AGENT_SLUG: z.string().default('wms'),
  ASR_MODEL: z.string().default('paraformer-realtime-v2'),
  ASR_VOCABULARY_ID: z.string().default(''),
  // 百炼 Paraformer v2 的 VAD 断句静音阈值（ms），0 表示使用服务默认值。
  ASR_MAX_SENTENCE_SILENCE: z.coerce.number().min(0).max(6000).default(500),
  // 本地 FunASR 热词，格式：词:权重,词:权重
  ASR_HOTWORDS: z.string().default('超宝:20'),
  // 声纹余弦相似度阈值，需用真实录音标定。
  SPEAKER_THRESHOLD: z.coerce.number().min(0).max(1).default(0.5),
  TTS_MODEL: z.string().default('cosyvoice-v2'),
  TTS_VOICE: z.string().default('longxiaochun_v2'),
  LIVEKIT_URL: z.url().default('ws://127.0.0.1:7880'),
  LIVEKIT_INTERNAL_URL: z.url().default('ws://127.0.0.1:7880'),
  LIVEKIT_API_KEY: z.string().default('devkey'),
  LIVEKIT_API_SECRET: z.string().default('secret'),
  WAKE_WORD: z.string().default('你好超宝'),
  // 只说唤醒词时的语音应答，逗号分隔多条随机播报；设为空字符串则改为提示音。
  /** 唤醒词的拼音 token（可选，多个读法用 | 分隔）；留空按 WAKE_WORD 自动生成。 */
  WAKE_WORD_PINYIN: z.string().default(''),
  WAKE_ACK: z.string().default('我在'),
  // 回答过程中再次唤醒（停止当前回答）后的语音应答，逗号分隔；留空则沿用 WAKE_ACK。
  REWAKE_ACK: z.string().default('我在'),
  // 本地唤醒（sherpa-onnx）灵敏度：阈值越低越容易唤醒，加权越高越容易唤醒。
  // 一级只负责“宁可多报”，误报由服务端 ASR 复核过滤。
  KWS_THRESHOLD: z.coerce.number().min(0.01).max(0.9).default(0.15),
  KWS_BOOST: z.coerce.number().min(0.5).max(5).default(2),
  // 唤醒链路是否叠加 RNNoise（浏览器已自带降噪，叠加可能损伤语音，建议实测对比）。
  KWS_DENOISE: z.enum(['true', 'false']).default('true'),
  PORT: z.coerce.number().default(3001),
  // 同时在线的语音页面数量；失联连接由服务端心跳回收。
  MAX_SESSIONS: z.coerce.number().int().min(1).max(256).default(32),
  // 监听地址，默认 0.0.0.0（本机和局域网都能访问）；只允许本机访问时填 127.0.0.1。
  // 只能填一个地址，误填成逗号分隔的多个地址时按 0.0.0.0 处理。
  HOST: z
    .string()
    .default('0.0.0.0')
    .transform((h) => (h.includes(',') || !h.trim() ? '0.0.0.0' : h.trim())),
  LOCAL_ASR_URL: z.url().default('ws://127.0.0.1:10095'),
  LOCAL_TTS_URL: z.url().default('http://127.0.0.1:50000/inference_sft'),
  LOCAL_TTS_VOICE: z.string().default('中文女'),
  LOCAL_LLM_API_KEY: z.string().default('local'),
  TURN_MODEL: z.string().default(''),
  SPECULATIVE: z.enum(['true', 'false']).default('true'),
  // 句子明显没说完（如“帮我查询”“我想查一下”“还有”）时，停顿多久才当作说完（ms）。
  INCOMPLETE_PAUSE_MS: z.coerce.number().min(800).max(8000).default(3000),
  // 每次提问都要先说唤醒词：关闭回答后的免唤醒追问和回答中本人开口即打断（唤醒词、“别说了 / 暂停”仍可打断）。
  WAKE_REQUIRED: z.enum(['true', 'false']).default('true'),
  FOLLOWUP_MS: z.coerce.number().min(1000).max(30000).default(8000),
});
export type Config = z.infer<typeof schema>;
export const config = schema.parse(process.env);
