import '../net.js';
import { randomUUID } from 'node:crypto';
import type { Message } from '../../shared/protocol.js';
import type { LLMProvider } from './types.js';

type Chunk = { stream_event?: { type?: string; content?: string } };
type Envelope = {
  payload?: { chunk?: Chunk; items?: Chunk[]; status?: string };
};

/** 每次回答使用独立临时线程，避免投机、打断和清空后残留服务器上下文。 */
export class YuxiLLM implements LLMProvider {
  constructor(
    private base: string,
    private key: string,
    private agent: string,
  ) {
    if (!key || !agent) throw new Error('请配置 YUXI_API_KEY 和 YUXI_AGENT_SLUG。');
  }

  private async request(route: string, init: RequestInit = {}) {
    const response = await fetch(`${this.base.replace(/\/$/, '')}/api${route}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(15000),
      headers: {
        Authorization: `Bearer ${this.key}`,
        'Content-Type': 'application/json',
      },
    });
    if (!response.ok)
      throw new Error(`Yuxi 接口失败（HTTP ${response.status}），请检查服务、智能体和接口密钥。`);
    return response;
  }

  async *chat(messages: Message[], signal: AbortSignal) {
    signal.throwIfAborted();
    let threadId: string | undefined;
    let runId: string | undefined;
    let ended = false;
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
    try {
      // 创建操作使用独立超时，拿到 ID 后再响应取消，确保能清理已创建的资源。
      const thread = await (
        await this.request('/chat/thread', {
          method: 'POST',
          body: JSON.stringify({ agent_id: this.agent, title: '超宝语音问答' }),
        })
      ).json();
      threadId = thread.id;
      if (!threadId) throw new Error('Yuxi 未返回会话编号。');
      requestSignal.throwIfAborted();
      const last = messages.at(-1);
      if (!last || last.role !== 'user') throw new Error('Yuxi 问答缺少用户问题。');
      const context = messages.slice(0, -1);
      const query = [
        '以下是语音会话的上下文。沿用你的业务知识和工具，回答最后的用户问题。回答会直接朗读，请简洁、口语化，避免 Markdown 和表格。',
        `会话上下文（JSON）：${JSON.stringify(context)}`,
        `用户当前问题：${last.content}`,
      ].join('\n');
      const run = await (
        await this.request('/agent/runs', {
          method: 'POST',
          body: JSON.stringify({
            agent_slug: this.agent,
            thread_id: threadId,
            query,
            meta: { request_id: randomUUID() },
          }),
        })
      ).json();
      runId = run.run_id;
      if (!runId) throw new Error('Yuxi 未返回运行编号。');
      requestSignal.throwIfAborted();
      const response = await this.request(
        `/agent/runs/${encodeURIComponent(runId)}/events?verbose=false`,
        {
          signal: requestSignal,
        },
      );
      if (!response.body) throw new Error('Yuxi 未返回回答事件流。');
      let pending = '';
      let event = '';
      let data: string[] = [];
      let received = false;
      for await (const part of response.body.pipeThrough(new TextDecoderStream())) {
        pending += part;
        const lines = pending.split('\n');
        pending = lines.pop()!;
        for (const raw of lines) {
          const line = raw.replace(/\r$/, '');
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
          else if (!line) {
            if (data.length) {
              const envelope = JSON.parse(data.join('\n')) as Envelope;
              if (event === 'error') throw new Error('Yuxi 回答失败，请检查服务端运行日志。');
              if (event === 'messages') {
                const payload = envelope.payload;
                const chunks = payload?.items ?? (payload?.chunk ? [payload.chunk] : []);
                for (const chunk of chunks) {
                  const delta = chunk.stream_event;
                  // 不将推理、工具调用或消息快照作为朗读内容。
                  if (delta?.type === 'message_delta' && delta.content) {
                    requestSignal.throwIfAborted();
                    received = true;
                    yield delta.content;
                  }
                }
              }
              if (event === 'end') ended = true;
            }
            event = '';
            data = [];
          }
        }
        if (ended) break;
      }
      if (!ended) throw new Error('Yuxi 回答连接中断，请重试。');
      const result = await (
        await this.request(`/agent/runs/${encodeURIComponent(runId)}/result`, {
          signal: requestSignal,
        })
      ).json();
      if (result.status !== 'completed')
        throw new Error('Yuxi 任务未成功完成，请检查服务端运行日志。');
      if (!received && typeof result.output === 'string' && result.output) {
        received = true;
        yield result.output;
      }
      if (!received) throw new Error('Yuxi 没有返回回答文本。');
    } finally {
      if (runId && !ended)
        await this.request(`/agent/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' })
          .then((r) => r.body?.cancel())
          .catch(() => console.warn('Yuxi 任务取消失败，请检查服务连接。'));
      if (threadId)
        await this.request(`/chat/thread/${encodeURIComponent(threadId)}`, { method: 'DELETE' })
          .then((r) => r.body?.cancel())
          .catch(() => console.warn('Yuxi 临时会话清理失败，请检查服务连接。'));
    }
  }
}
