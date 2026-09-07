'use strict';

// 冒烟测试:真实拉起 server(临时 profile/端口),验证:
//   1) 正常模式:能启动、静态页可达、旧写盘接口已移除(404)、/api/chat 空文件给 400
//   2) 引导模式(无配置):根路径 302 到配置生成页、/api/chat 被拦(503)
// 运行:npm test(或 node test/smoke.js)。测试结束清理临时 profile,不影响真实配置。
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG_DIR = path.join(ROOT, 'server', 'config');
const children = [];
const temps = [];
let failures = 0;

function freePort() {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => res(p));
    });
  });
}

function httpGet(port, p, method = 'GET') {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, timeout: 1000 }, (r) => {
      let body = '';
      r.on('data', (c) => { body += c; });
      r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body }));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function waitReady(port, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const r = await httpGet(port, '/config-builder.html');
    if (r && r.status === 200) return true;
    await new Promise((r2) => setTimeout(r2, 150));
  }
  return false;
}

function boot(env) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, ...env }, stdio: 'ignore',
  });
  children.push(child);
  return child;
}

function writeTempProfile(profile, port) {
  const file = path.join(CONFIG_DIR, `${profile}.json`);
  fs.writeFileSync(file, JSON.stringify({
    profile, wakeWords: [], server: { port, tmpDir: '/tmp/voiceagent-test' },
    asr: { provider: 'paraformer-http', url: 'http://127.0.0.1:1', endpoint: '/x', timeoutMs: 1000 },
    llm: { provider: 'openai-compatible', apiKey: 'x', baseUrl: 'http://127.0.0.1:1/v1', model: 'm', timeoutMs: 1000 },
    tts: { provider: 'cosyvoice-http', url: 'http://127.0.0.1:1', endpoint: '/e',
      promptWav: 'server/config/prompt_wav.wav', promptText: 'x',
      sampleRate: 24000, channels: 1, bitsPerSample: 16, timeoutMs: 1000 },
  }, null, 2));
  temps.push(file);
}

function expect(name, cond, extra) {
  if (cond) console.log(`✓ ${name}`);
  else { failures++; console.error(`✗ ${name}${extra ? ' → ' + JSON.stringify(extra) : ''}`); }
}

(async () => {
  // ---- 1) 正常模式 ----
  const port1 = await freePort();
  writeTempProfile('__smoke1', port1);
  boot({ VA_PROFILE: '__smoke1', VA_NO_OPEN: '1' });
  if (!(await waitReady(port1))) throw new Error('正常模式启动超时');
  const root = await httpGet(port1, '/');
  expect('正常模式: 首页/静态 200', root && root.status === 200, root);
  const save404 = await httpGet(port1, '/api/configs', 'POST');
  expect('正常模式: 旧写盘接口已移除(404)', save404 && save404.status === 404, save404);
  const chatEmpty = await httpGet(port1, '/api/chat', 'POST');
  expect('正常模式: /api/chat 空文件 400(含错误提示)', chatEmpty && chatEmpty.status === 400 && /error/.test(chatEmpty.body), chatEmpty);
  const pets = await httpGet(port1, '/api/pets');
  expect('正常模式: /api/pets 只读列表,含 demo', pets && pets.status === 200 && /demo/.test(pets.body), pets);
  children[0].kill('SIGTERM');

  // ---- 2) 引导模式(指向不存在的 profile) ----
  const port2 = await freePort();
  boot({ VA_PROFILE: '__smoke_missing', VA_PORT: String(port2), VA_NO_OPEN: '1' });
  if (!(await waitReady(port2))) throw new Error('引导模式启动超时');
  const root2 = await httpGet(port2, '/');
  expect('引导模式: 根路径 302 → 配置生成页', root2 && root2.status === 302 &&
    /config-builder\.html\?first=1/.test(root2.headers.location || ''), root2);
  const chat503 = await httpGet(port2, '/api/chat', 'POST');
  expect('引导模式: /api/chat 被拦(503 引导提示)', chat503 && chat503.status === 503 && /尚未生成配置/.test(chat503.body), chat503);
  children[1].kill('SIGTERM');
})().catch((e) => { console.error('冒烟异常:', e.message); failures++; })
  .finally(() => {
    children.forEach((c) => { try { c.kill('SIGTERM'); } catch {} });
    temps.forEach((f) => { try { fs.rmSync(f, { force: true }); } catch {} });
    if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
    console.log('\n冒烟测试全部通过');
  });
