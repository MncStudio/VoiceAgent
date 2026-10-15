import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
const exe =
  process.platform === 'win32'
    ? '.runtime/livekit/livekit-server.exe'
    : '.runtime/livekit/livekit-server';
if (!existsSync(exe)) {
  console.error('请先运行 npm run setup:livekit，或使用 docker compose up -d livekit。');
  process.exit(1);
}
const child = spawn(exe, ['--dev', '--bind', '127.0.0.1'], { stdio: 'inherit', windowsHide: true });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill());
child.on('exit', (code) => process.exit(code ?? 0));
