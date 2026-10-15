import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { download, get } from './download.mjs';
await mkdir('.runtime/livekit', { recursive: true });
const exe =
  process.platform === 'win32'
    ? '.runtime/livekit/livekit-server.exe'
    : '.runtime/livekit/livekit-server';
if (existsSync(exe)) {
  console.log('LiveKit 已安装。');
  process.exit(0);
}
// Override for reproducible/offline installs. Default version is pinned after verification.
const version = process.env.LIVEKIT_VERSION || '1.9.12';
const platform =
  process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
const ext = platform === 'windows' ? 'zip' : 'tar.gz';
const archive = `.runtime/livekit/livekit.${ext}`;
await download(
  `https://github.com/livekit/livekit/releases/download/v${version}/livekit_${version}_${platform}_${arch}.${ext}`,
  archive,
);
if (platform === 'windows') execFileSync('tar', ['-xf', archive, '-C', '.runtime/livekit']);
else {
  execFileSync('tar', ['-xzf', archive, '-C', '.runtime/livekit']);
  execFileSync('chmod', ['+x', exe]);
}
console.log(`LiveKit ${version} 已安装。运行 npm run livekit。`);
