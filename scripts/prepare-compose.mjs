import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from 'dotenv';

const address = process.argv[2] || '192.168.30.109';
if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) throw new Error('Pass the deployment IPv4 address');
const env = parse(readFileSync('.env'));
if (env.PROVIDER !== 'dashscope' || !env.DASHSCOPE_API_KEY) throw new Error('Current .env does not configure online speech models');
const destination = path.resolve('.runtime/deploy-compose');
mkdirSync(destination, { recursive: true });
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const imageTag = `${revision.slice(0, 7)}-${stamp}`;
copyFileSync('.env', path.join(destination, 'voiceagent.env'));
writeFileSync(path.join(destination, 'livekit.yaml'), [
  'port: 7880', 'bind_addresses: ["0.0.0.0"]', 'rtc:',
  '  tcp_port: 7881', '  udp_port: 7882', '  use_external_ip: false', `  node_ip: ${address}`,
  'keys:', `  ${JSON.stringify(env.LIVEKIT_API_KEY || 'devkey')}: ${JSON.stringify(env.LIVEKIT_API_SECRET || 'secret')}`,
  'logging:', '  level: info', '',
].join('\n'), { mode: 0o600 });
writeFileSync(path.join(destination, 'compose.env'), [
  `IMAGE_TAG=${imageTag}`, `SOURCE_REVISION=${revision}`,
  'VOICE_UID=999', 'VOICE_GID=987',
  'VOICE_ENV_FILE=/opt/digital-employee-9600/compose/voiceagent/config/voiceagent.env',
  'LIVEKIT_CONFIG_FILE=/opt/digital-employee-9600/compose/voiceagent/config/livekit.yaml',
  'VOICE_RUNTIME_DIR=/opt/digital-employee-9600/compose/voiceagent/runtime',
  `LIVEKIT_PUBLIC_URL=wss://${address}:9600/livekit`, '',
].join('\n'));
writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify({ revision, imageTag, stamp }, null, 2));
console.log(JSON.stringify({ destination, imageTag, revision, provider: env.PROVIDER, wakeWord: env.WAKE_WORD, wakeRequired: env.WAKE_REQUIRED ?? 'true (code default)' }));
