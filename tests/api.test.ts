import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
let child: ChildProcess;
const base = 'http://127.0.0.1:3109';
const ids: string[] = [];
beforeAll(async () => {
  child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    env: { ...process.env, PROVIDER: 'demo', PORT: '3109', HOST: '127.0.0.1', WAKE_WORD: '你好超宝' },
    stdio: 'pipe',
    windowsHide: true,
  });
  // tsx 冷启动在 Windows 或繁忙构建机上可能超过四秒。
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('测试服务启动超时');
}, 20000);
afterAll(async () => {
  for (const id of ids)
    await fetch(`${base}/api/sessions/${id}`, { method: 'DELETE' }).catch(() => {});
  child?.kill();
});
describe('本地 API 边界', () => {
  it('SDK 使用当前唤醒 Worker，避免 dist/web 的旧副本覆盖反向代理路径修复', async () => {
    const r = await fetch(`${base}/kws-worker.js`, { headers: { Origin: base } });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('javascript');
    expect(await r.text()).toBe(readFileSync('web/public/kws-worker.js', 'utf8'));
  });
  it('公共配置没有服务端密钥', async () => {
    const r = await fetch(`${base}/api/config`);
    const body = await r.text();
    expect(body).not.toMatch(/DASHSCOPE_API_KEY|LIVEKIT_API_SECRET|YUXI_API_KEY|yxkey_|sk-ws-/);
    expect(JSON.parse(body)).toMatchObject({ provider: 'demo', wakeWord: '你好超宝' });
  });
  it('不限制网页来源：局域网 IP 等任意来源都能创建会话', async () => {
    const origin = 'http://192.168.110.116';
    const r = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { Origin: origin } });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe(origin);
    ids.push((await r.json()).id);
  });
  it('其他系统可跨域使用 SDK：预检、CORS 头与端侧资源', async () => {
    const pre = await fetch(`${base}/api/sessions`, {
      method: 'OPTIONS',
      headers: {
        Origin: base,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(base);
    expect(pre.headers.get('access-control-allow-methods')).toContain('DELETE');
    const config = await fetch(`${base}/api/config`, { headers: { Origin: base } });
    expect(config.headers.get('access-control-allow-origin')).toBe(base);
    expect(config.headers.get('cache-control')).toBe('no-store');
    const worker = await fetch(`${base}/kws-worker.js`, { headers: { Origin: base } });
    expect(worker.status).toBe(200);
    expect(worker.headers.get('access-control-allow-origin')).toBe(base);
    expect(worker.headers.get('cache-control')).not.toBe('no-store');
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
