import '../net.js';
import type { Message } from '../../shared/protocol.js';
import type { LLMProvider } from './types.js';
export class OpenAILLM implements LLMProvider {
  constructor(
    private base: string,
    private key: string,
    private model: string,
  ) {}
  async *chat(messages: Message[], signal: AbortSignal) {
    const response = await fetch(`${this.base.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
      headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: true,
        max_tokens: 512,
        enable_thinking: false,
      }),
    });
    if (!response.ok || !response.body)
      throw new Error(`LLM 接口失败（HTTP ${response.status}），请检查模型、地域和密钥权限。`);
    let pending = '';
    for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop()!;
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        const value = JSON.parse(data);
        if (value.error) throw new Error('LLM 流式服务返回错误。');
        const text = value.choices?.[0]?.delta?.content;
        if (text) yield text as string;
      }
    }
  }
}
