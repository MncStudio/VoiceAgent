import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fetch, ProxyAgent, Agent } from 'undici';
const proxy = process.env.https_proxy || process.env.HTTPS_PROXY;
const dispatcher = proxy ? new ProxyAgent(proxy) : new Agent();
export async function get(url) {
  const r = await fetch(url, {
    dispatcher,
    signal: AbortSignal.timeout(120000),
    headers: { 'User-Agent': 'Chaobao-development-setup' },
  });
  if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}: ${url}`);
  return r;
}
export async function download(url, file) {
  await mkdir(path.dirname(file), { recursive: true });
  const partial = `${file}.partial`;
  try {
    await promisify(execFile)(
      process.platform === 'win32' ? 'curl.exe' : 'curl',
      [
        '--location',
        '--fail',
        '--silent',
        '--show-error',
        '--retry',
        '2',
        '--max-time',
        '180',
        ...(proxy ? ['--proxy', proxy] : []),
        '--output',
        partial,
        url,
      ],
      { windowsHide: true },
    );
    await rename(partial, file);
    console.log(`已下载 ${file}`);
  } catch (error) {
    await rm(partial, { force: true });
    throw new Error(`资源下载失败：${url}（${error.code ?? 'network'}）`);
  }
}
