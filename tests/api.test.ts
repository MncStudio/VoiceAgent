import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from 'ws';
let child: ChildProcess;
const base = 'http://127.0.0.1:3109';
const ids: string[] = [];
beforeAll(async () => {
  child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    env: { ...process.env, PROVIDER: 'demo', PORT: '3109', ALLOWED_ORIGINS: base },
    stdio: 'pipe',
    windowsHide: true,
  });
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('测试服务启动超时');
});
afterAll(async () => {
  for (const id of ids)
    await fetch(`${base}/api/sessions/${id}`, { method: 'DELETE' }).catch(() => {});
  child?.kill();
});
describe('本地 API 边界', () => {
  it('公共配置没有服务端密钥', async () => {
    const r = await fetch(`${base}/api/config`);
    const body = await r.text();
    expect(body).not.toMatch(/DASHSCOPE_API_KEY|LIVEKIT_API_SECRET|sk-ws-/);
    expect(JSON.parse(body)).toMatchObject({ provider: 'demo', wakeWord: '你好超宝' });
  });
  it('拒绝未经允许的网页来源创建会话', async () => {
    const r = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { Origin: 'https://example.org' },
    });
    expect(r.status).toBe(403);
  });
  it('控制连接验证消息且删除会话后断开', async () => {
    const s = await (await fetch(`${base}/api/sessions`, { method: 'POST' })).json();
    ids.push(s.id);
    const ws = new WebSocket(`ws://127.0.0.1:3109/control?session=${s.id}`, { origin: base });
    const initial = once(ws, 'message');
    await once(ws, 'open');
    await initial;
    const invalid = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'text', text: 'x'.repeat(2001) }));
    const [data] = await invalid;
    expect(JSON.parse(data.toString())).toMatchObject({ type: 'error' });
    const closed = once(ws, 'close');
    await fetch(`${base}/api/sessions/${s.id}`, { method: 'DELETE' });
    await closed;
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });
});
