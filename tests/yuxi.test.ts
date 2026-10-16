import { afterEach, describe, expect, it, vi } from 'vitest';
import { YuxiLLM } from '../server/providers/yuxi';

afterEach(() => vi.unstubAllGlobals());

function harness(stream: Response, result = { status: 'completed', output: '完整回答' }) {
  const calls: { path: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      calls.push({ path, init });
      if (path.endsWith('/events')) return stream;
      if (path.endsWith('/result')) return Response.json(result);
      if (path === '/api/chat/thread') return Response.json({ id: 'thread-1' });
      if (path === '/api/agent/runs') return Response.json({ run_id: 'run-1' });
      return Response.json({});
    }),
  );
  const model = new YuxiLLM('http://yuxi.test', 'test-secret', 'wms');
  return { model, calls };
}

function events(parts: string[]) {
  const bytes = new TextEncoder().encode(parts.join(''));
  // 按单字节传输，覆盖 UTF-8 中文和 SSE 行被切开的情况。
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    }),
  );
}
const message = (content: object) =>
  `event: messages\r\ndata: ${JSON.stringify({ payload: { chunk: { stream_event: content } } })}\r\n\r\n`;
const end = 'event: end\ndata: {"payload":{"status":"completed"}}\n\n';
const question = [{ role: 'user' as const, content: '公司叫什么？' }];

describe('Yuxi 问答适配', () => {
  it('只输出正文增量，携带上下文，并在完成后删除临时线程', async () => {
    const { model, calls } = harness(
      events([
        ': heartbeat\n\n',
        message({ type: 'message_delta', reasoning_content: '内部推理' }),
        message({ type: 'tool_call', content: '工具参数' }),
        message({ type: 'message_delta', content: '你好，' }),
        `event: messages\ndata: ${JSON.stringify({ payload: { items: [{ stream_event: { type: 'message_delta', content: '超宝。' } }] } })}\n\n`,
        end,
      ]),
    );
    const output: string[] = [];
    for await (const text of model.chat(
      [
        { role: 'user', content: '我叫小王' },
        { role: 'assistant', content: '你好，小王' },
        ...question,
      ],
      new AbortController().signal,
    ))
      output.push(text);
    expect(output).toEqual(['你好，', '超宝。']);
    const body = JSON.parse(calls.find((c) => c.path === '/api/agent/runs')!.init.body as string);
    expect(body).toMatchObject({ agent_slug: 'wms', thread_id: 'thread-1' });
    expect(body.query).toContain('我叫小王');
    expect(body.query).toContain('公司叫什么？');
    expect(calls.at(-1)).toMatchObject({
      path: '/api/chat/thread/thread-1',
      init: { method: 'DELETE' },
    });
    expect(calls.some((c) => c.path.endsWith('/cancel'))).toBe(false);
  });

  it('没有正文增量时读取最终回答', async () => {
    const { model } = harness(events([end]));
    const output: string[] = [];
    for await (const text of model.chat(question, new AbortController().signal)) output.push(text);
    expect(output).toEqual(['完整回答']);
  });

  it('打断后取消远程任务并清理线程', async () => {
    const { model, calls } = harness(
      events([message({ type: 'message_delta', content: '第一句。' })]),
    );
    const abort = new AbortController();
    for await (const _text of model.chat(question, abort.signal)) {
      abort.abort();
      break;
    }
    expect(calls.slice(-2).map((c) => [c.path, c.init.method])).toEqual([
      ['/api/agent/runs/run-1/cancel', 'POST'],
      ['/api/chat/thread/thread-1', 'DELETE'],
    ]);
  });

  it('流意外断开时报告失败并取消任务', async () => {
    const { model, calls } = harness(
      events([message({ type: 'message_delta', content: '未完成' })]),
    );
    await expect(async () => {
      for await (const _text of model.chat(question, new AbortController().signal)) {
        /* consume */
      }
    }).rejects.toThrow('连接中断');
    expect(calls.some((c) => c.path.endsWith('/cancel'))).toBe(true);
  });

  it('任务失败时不把最终文本当成成功回答', async () => {
    const { model } = harness(events([end]), { status: 'failed', output: '旧回答' });
    await expect(async () => {
      for await (const _text of model.chat(question, new AbortController().signal)) {
        /* consume */
      }
    }).rejects.toThrow('未成功完成');
  });
});
