import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { DashScopeASR, DashScopeTTS } from '../server/providers/dashscope';
import { Conversation } from '../server/engine';
import type { ServerEvent } from '../shared/protocol';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

// 收到升级请求后暂停握手，稳定复现用户在连接建立前继续提问 / 打断。
async function pendingHandshake(rejectHandshake = false) {
  const server = createServer();
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const requested = new Promise<void>((resolve) =>
    server.once('upgrade', (_req, socket) => {
      if (rejectHandshake) socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      else {
        socket.resume();
        socket.once('end', () => socket.end());
      }
      resolve();
    }),
  );
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  const port = (server.address() as { port: number }).port;
  return { url: `ws://127.0.0.1:${port}`, requested, connections: () => sockets.size };
}

describe('百炼连接取消', () => {
  it('真实握手失败仍向界面提示错误', async () => {
    const { url } = await pendingHandshake(true);
    const events: ServerEvent[] = [];
    const c = new Conversation(
      {
        demo: false,
        asr: new DashScopeASR(url, 'k', 'paraformer-realtime-v2'),
        llm: { async *chat() {} },
        tts: { async *synth() {} },
      },
      (event) => events.push(event),
      { wakeWord: '你好超宝', followupMs: 8000 },
    );
    cleanup.push(() => c.close());
    c.handle({ type: 'wake', source: 'button' });
    await expect
      .poll(() => events.filter((e) => e.type === 'error'))
      .toEqual([{ type: 'error', message: '百炼语音连接失败，请检查网络、地域和密钥。' }]);
    expect(c.state).toBe('IDLE');
  });

  it('关闭 Provider 会释放仍在握手的预热连接', async () => {
    const { url, requested, connections } = await pendingHandshake();
    const tts = new DashScopeTTS(url, 'k', 'cosyvoice-v2', 'v');
    cleanup.push(() => tts.close());
    tts.warm();
    await requested;
    expect(connections()).toBe(1);
    tts.close();
    await expect.poll(connections).toBe(0);
  });

  it.each(['ASR', 'TTS'])('%s 握手期间取消保留取消原因，不报密钥 / 网络错误', async (kind) => {
    const { url, requested } = await pendingHandshake();
    const controller = new AbortController();
    const provider =
      kind === 'ASR'
        ? new DashScopeASR(url, 'k', 'paraformer-realtime-v2')
        : new DashScopeTTS(url, 'k', 'cosyvoice-v2', 'v');
    cleanup.push(() => provider.close());
    const operation =
      provider instanceof DashScopeASR
        ? provider.open(
            () => {},
            () => {},
            controller.signal,
          )
        : provider.synth('你好。', controller.signal)[Symbol.asyncIterator]().next();
    const reason = new DOMException('用户打断', 'AbortError');
    const rejected = expect(operation).rejects.toBe(reason);
    await requested;
    controller.abort(reason);
    await rejected;
  });

  it('等待预热握手期间也能立即取消识别', async () => {
    const { url, requested } = await pendingHandshake();
    const asr = new DashScopeASR(url, 'k', 'paraformer-realtime-v2');
    cleanup.push(() => asr.close());
    asr.warm();
    await requested;
    const controller = new AbortController();
    const operation = asr.open(
      () => {},
      () => {},
      controller.signal,
    );
    const reason = new DOMException('用户打断', 'AbortError');
    const result = operation.catch((error: unknown) => error);
    controller.abort(reason);
    expect(
      await Promise.race([
        result,
        new Promise((resolve) => setTimeout(() => resolve('取消仍在等待握手'), 100)),
      ]),
    ).toBe(reason);
  });

  it('唤醒握手中被打断时不向界面发送连接错误', async () => {
    const { url, requested } = await pendingHandshake();
    const events: ServerEvent[] = [];
    const asr = new DashScopeASR(url, 'k', 'paraformer-realtime-v2');
    const c = new Conversation(
      {
        demo: false,
        asr,
        llm: {
          async *chat() {
            yield '你好。';
          },
        },
        tts: { async *synth() {} },
      },
      (event) => events.push(event),
      { wakeWord: '你好超宝', followupMs: 8000 },
    );
    cleanup.push(() => c.close());
    c.handle({ type: 'wake', source: 'button' });
    await requested;
    c.handle({ type: 'interrupt', reason: 'stop' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(c.state).toBe('IDLE');
  });
});
