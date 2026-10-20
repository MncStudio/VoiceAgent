import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChaobaoAssistant } from '../web/src/sdk';
const clients = vi.hoisted(() => [] as { sent: unknown[]; external: boolean }[]);
vi.mock('../web/src/client', () => ({
  AssistantClient: class {
    sent: unknown[] = [];
    constructor(_event: unknown, _audio: unknown, _level: unknown, _lost: unknown, public external: boolean) { clients.push(this); }
    async connect() {}
    send(event: unknown) { this.sent.push(event); }
    async close() {}
  },
}));
afterEach(() => { clients.length = 0; vi.unstubAllGlobals(); });
const turnId = '6d5f6325-b1e4-4974-8bc8-8cf22810ae51';
async function bot() {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ provider: 'demo' }))));
  const instance = new ChaobaoAssistant({ external: true });
  await instance.connect();
  return instance;
}
describe('SDK 宿主回答', () => {
  it('携带 external 模式，并合并同一批正文避免瞬间超出消息限流', async () => {
    const instance = await bot();
    for (let i = 0; i < 100; i++) instance.appendAnswer(turnId, '业务正文。');
    instance.appendAnswer(turnId, '', true);
    await Promise.resolve();
    expect(clients[0].external).toBe(true);
    expect(clients[0].sent).toEqual([
      { type: 'host-answer', turnId, text: '业务正文。'.repeat(100) },
      { type: 'host-answer', turnId, text: '', done: true },
    ]);
    await instance.destroy();
  });
  it('暂停在批次发出前丢弃待播文字，销毁后也不再发包', async () => {
    const instance = await bot();
    instance.appendAnswer(turnId, '不能继续播。');
    instance.stop();
    await Promise.resolve();
    expect(clients[0].sent).toEqual([{ type: 'interrupt', reason: 'stop' }]);
    instance.appendAnswer(turnId, '销毁前待发。');
    await instance.destroy();
    instance.appendAnswer(turnId, '销毁后待发。');
    await Promise.resolve();
    expect(clients[0].sent).toHaveLength(1);
  });
});
