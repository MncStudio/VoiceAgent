import 'dotenv/config';
import { z } from 'zod';
const schema = z.object({
  PROVIDER: z.enum(['demo', 'dashscope', 'local']).default('demo'),
  DASHSCOPE_API_KEY: z.string().default(''),
  DASHSCOPE_WS_URL: z.url().default('wss://dashscope.aliyuncs.com/api-ws/v1/inference'),
  LLM_BASE_URL: z.url().default('https://dashscope.aliyuncs.com/compatible-mode/v1'),
  LLM_MODEL: z.string().default('qwen-plus'),
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
  WAKE_ACK: z.string().default('我在'),
  PORT: z.coerce.number().default(3001),
  HOST: z.string().default('127.0.0.1'),
  ALLOWED_ORIGINS: z
    .string()
    .default('http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:3001'),
  LOCAL_ASR_URL: z.url().default('ws://127.0.0.1:10095'),
  LOCAL_TTS_URL: z.url().default('http://127.0.0.1:50000/inference_sft'),
  LOCAL_TTS_VOICE: z.string().default('中文女'),
  LOCAL_LLM_API_KEY: z.string().default('local'),
  TURN_MODEL: z.string().default(''),
  SPECULATIVE: z.enum(['true', 'false']).default('true'),
  FOLLOWUP_MS: z.coerce.number().min(1000).max(30000).default(8000),
});
export type Config = z.infer<typeof schema>;
export const config = schema.parse(process.env);
