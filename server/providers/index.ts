import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from '../config.js';
import type { Providers } from './types.js';
import { OpenAILLM } from './llm.js';
import { DashScopeASR, DashScopeTTS } from './dashscope.js';
import { FunASR, CosyVoiceLocal } from './local.js';
export function parseHotwords(value: string) {
  const words: Record<string, number> = {};
  for (const item of value.split(',')) {
    const [word, weight] = item.split(':').map((x) => x.trim());
    if (word) words[word] = Number(weight) || 20;
  }
  return words;
}
export function createProviders(c: Config): Providers {
  if (c.PROVIDER === 'demo')
    return {
      demo: true,
      asr: {
        async open() {
          throw new Error('演示模式不识别麦克风，请使用文本对话。');
        },
      },
      llm: {
        async *chat(messages, signal) {
          const text = messages.at(-1)?.content ?? '';
          const reply = text.includes('打断')
            ? '你可以随时点击暂停，或在语音连接后说“别说了”。我会取消当前回答，转为倾听。'
            : `收到，你说的是“${text}”。这是本地演示回答。接入百炼并连接语音后，就可以和超宝自然交谈了。`;
          for (const char of reply) {
            await delay(18, undefined, { signal });
            yield char;
          }
        },
      },
      tts: { async *synth() {} },
    };
  return {
    demo: false,
    asr:
      c.PROVIDER === 'local'
        ? new FunASR(c.LOCAL_ASR_URL, parseHotwords(c.ASR_HOTWORDS))
        : new DashScopeASR(
            c.DASHSCOPE_WS_URL,
            c.DASHSCOPE_API_KEY,
            c.ASR_MODEL,
            c.ASR_VOCABULARY_ID,
            c.ASR_MAX_SENTENCE_SILENCE,
          ),
    llm: new OpenAILLM(
      c.LLM_BASE_URL,
      c.PROVIDER === 'local' ? c.LOCAL_LLM_API_KEY : c.DASHSCOPE_API_KEY,
      c.LLM_MODEL,
    ),
    tts:
      c.PROVIDER === 'local'
        ? new CosyVoiceLocal(c.LOCAL_TTS_URL, c.LOCAL_TTS_VOICE)
        : new DashScopeTTS(c.DASHSCOPE_WS_URL, c.DASHSCOPE_API_KEY, c.TTS_MODEL, c.TTS_VOICE),
  };
}
