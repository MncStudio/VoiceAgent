import express from 'express';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from './config.js';
import { kwsTokens } from './audio.js';
import { Conversation } from './engine.js';
import { createProviders } from './providers/index.js';
import { clientEventSchema, type ServerEvent } from '../shared/protocol.js';
import { joinAgent, token } from './livekit.js';
import { SemanticPolicy } from './semantic.js';
import { OpenAILLM } from './providers/llm.js';
const app = express();
const server = createServer(app);
app.disable('x-powered-by');
app.use(express.json({ limit: '8kb' }));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  // 不限制网页来源：任何页面（含局域网 IP、其他系统）都可跨域使用 SDK；
  // 接口、模型、Worker 与 AudioWorklet 都需要 CORS。
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  // 只有接口禁止缓存；端侧模型体积大，按 ETag 协商缓存，避免每次打开都重新下载。
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});
type Session = {
  id: string;
  engine: Conversation;
  events: Set<WebSocket>;
  agent?: Awaited<ReturnType<typeof joinAgent>>;
  created: number;
  voicePending?: Promise<void>;
};
const sessions = new Map<string, Session>();
const publicRoot = path.resolve('web/public');
/**
 * 本地唤醒模型要用的唤醒词拼音 token：WAKE_WORD_PINYIN 优先，否则按 WAKE_WORD 自动生成。
 * 模型词表里没有的 token 会让唤醒模型初始化失败，这里先按 tokens.txt 过滤并提示。
 */
let wakeWarned = '';
function wakeTokens() {
  const wanted = config.WAKE_WORD_PINYIN.trim()
    ? config.WAKE_WORD_PINYIN.split('|')
        .map((s) => s.trim().replace(/\s+/gu, ' '))
        .filter(Boolean)
    : kwsTokens(config.WAKE_WORD);
  const file = path.join(publicRoot, 'models/kws/tokens.txt');
  if (!existsSync(file)) return wanted;
  const vocab = new Set(
    readFileSync(file, 'utf8')
      .split(/\r?\n/u)
      .map((l) => l.split(' ')[0]),
  );
  const valid = wanted.filter((line) => line.split(' ').every((t) => vocab.has(t)));
  const key = wanted.join('|');
  if (valid.length < wanted.length && wakeWarned !== key) {
    wakeWarned = key;
    const bad = wanted.filter((l) => !valid.includes(l));
    console.warn(
      `[wake] 唤醒词“${config.WAKE_WORD}”的拼音 ${bad.map((l) => `“${l}”`).join('、')} 含本地唤醒模型不认识的 token，已忽略；${config.WAKE_WORD_PINYIN.trim() ? '请检查' : '可用'} WAKE_WORD_PINYIN 手动指定。`,
    );
  }
  return valid;
}
app.get('/api/health', (_req, res) => res.json({ ok: true, provider: config.PROVIDER }));
app.get('/api/config', (_req, res) =>
  res.json({
    provider: config.PROVIDER,
    qaProvider: config.PROVIDER === 'demo' ? 'demo' : config.QA_PROVIDER,
    wakeWord: config.WAKE_WORD,
    wakeAck: config.WAKE_ACK,
    rewakeAck: config.REWAKE_ACK,
    followupMs: config.FOLLOWUP_MS,
    wakeRequired: config.WAKE_REQUIRED === 'true',
    llmModel: config.QA_PROVIDER === 'yuxi' ? `yuxi / ${config.YUXI_AGENT_SLUG}` : config.LLM_MODEL,
    asrModel: config.ASR_MODEL,
    ttsModel: config.TTS_MODEL,
    turnModel: config.TURN_MODEL,
    speculative: config.QA_PROVIDER !== 'yuxi' && config.SPECULATIVE === 'true',
    speakerThreshold: config.SPEAKER_THRESHOLD,
    kws: {
      threshold: config.KWS_THRESHOLD,
      boost: config.KWS_BOOST,
      denoise: config.KWS_DENOISE === 'true',
      tokens: wakeTokens(),
    },
    configured: config.PROVIDER !== 'dashscope' || !!config.DASHSCOPE_API_KEY,
    assets: {
      kws: [
        'sherpa-onnx-wasm-web.wasm',
        'encoder-epoch-12-avg-2-chunk-16-left-64.onnx',
        'tokens.txt',
      ].every((name) => existsSync(path.join(publicRoot, 'models/kws', name))),
      vad: existsSync(path.join(publicRoot, 'vendor/vad/silero_vad_v5.onnx')),
      speaker: existsSync(path.join(publicRoot, 'models/speaker/cam++.onnx')),
    },
  }),
);
app.post('/api/sessions', (req, res) => {
  if (sessions.size >= 8) {
    res.status(429).json({ error: '会话数已满，请先断开已有连接。' });
    return;
  }
  const id = randomUUID();
  const events = new Set<WebSocket>();
  const semantic = config.TURN_MODEL
    ? new SemanticPolicy(
        new OpenAILLM(
          config.LLM_BASE_URL,
          config.PROVIDER === 'local' ? config.LOCAL_LLM_API_KEY : config.DASHSCOPE_API_KEY,
          config.TURN_MODEL,
        ),
      )
    : undefined;
  const engine = new Conversation(
    createProviders(config),
    (event: ServerEvent) => {
      for (const ws of events) if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
    },
    {
      wakeWord: config.WAKE_WORD,
      wakeAck: config.WAKE_ACK.split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean),
      rewakeAck: config.REWAKE_ACK.split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean),
      followupMs: config.FOLLOWUP_MS,
      wakeRequired: config.WAKE_REQUIRED === 'true',
      missLog: config.WAKE_MISS_LOG === 'true',
      incompleteMs: config.INCOMPLETE_PAUSE_MS,
      speakerReject: Math.max(0, config.SPEAKER_THRESHOLD - 0.15),
      semantic,
      speculative:
        !req.body?.external && config.QA_PROVIDER !== 'yuxi' && config.SPECULATIVE === 'true',
      external: req.body?.external === true,
    },
  );
  sessions.set(id, { id, engine, events, created: Date.now() });
  res.json({ id });
});
app.post('/api/sessions/:id/voice', async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: '会话已过期。' });
    return;
  }
  if (config.PROVIDER === 'demo') {
    res.status(409).json({ error: '演示模式只支持文字。' });
    return;
  }
  try {
    if (!session.agent && !session.voicePending) {
      session.voicePending = joinAgent(config, `chaobao-${session.id}`, session.id, session.engine)
        .then((agent) => {
          session.agent = agent;
        })
        .finally(() => {
          session.voicePending = undefined;
        });
    }
    await session.voicePending;
    if (!sessions.has(session.id)) {
      await session.agent?.close();
      res.status(410).json({ error: '会话已结束。' });
      return;
    }
    res.json({
      url: config.LIVEKIT_URL,
      token: await token(config, `chaobao-${session.id}`, session.id),
      room: `chaobao-${session.id}`,
    });
  } catch {
    res.status(503).json({ error: '语音服务连接失败。请先运行 npm run livekit，再重新连接。' });
  }
});
async function remove(id: string) {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  session.engine.close();
  session.events.forEach((ws) => ws.close());
  await session.agent?.close();
}
app.delete('/api/sessions/:id', async (req, res) => {
  await remove(req.params.id);
  res.sendStatus(204);
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const id = url.searchParams.get('session') ?? '';
  if (url.pathname !== '/control' || !sessions.has(id)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const session = sessions.get(id)!;
    session.events.add(ws);
    ws.send(JSON.stringify({ type: 'state', state: session.engine.state }));
    let count = 0,
      windowStart = Date.now();
    ws.on('message', (data) => {
      if (Date.now() - windowStart > 1000) {
        count = 0;
        windowStart = Date.now();
      }
      if (++count > 80) {
        ws.close(1008, 'Too many events');
        return;
      }
      try {
        const event = clientEventSchema.safeParse(JSON.parse(data.toString()));
        if (event.success) session.engine.handle(event.data);
        else ws.send(JSON.stringify({ type: 'error', message: '消息格式错误。' }));
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: '无法解析消息。' }));
      }
    });
    ws.on('close', () => {
      session.events.delete(ws);
      setTimeout(() => {
        if (!session.events.size) void remove(id);
      }, 10000).unref();
    });
  });
});
// SDK（npm run build:sdk 生成）供其他系统通过 ${baseUrl}/sdk/chaobao-sdk.js 加载。
const sdk = path.resolve('dist/sdk');
// 始终注册，允许服务启动后才构建 SDK；缺失资源不能落入后面的 SPA HTML 回退。
app.use('/sdk', express.static(sdk, { cacheControl: true, maxAge: 0 }));
app.use('/sdk', (_req, res) =>
  res.status(404).json({ error: 'SDK 资源不存在，请在超宝服务目录运行 npm run build:sdk。' }),
);
const web = path.resolve('dist/web');
// 开发模式（未构建前端）下同样提供端侧模型、Worker 与 AudioWorklet，SDK 接入方可直接连 3001。
// public 是 SDK 配套资源的源文件，优先于旧 dist/web 中的副本，避免反代前缀等修复被旧构建覆盖。
app.use(express.static(publicRoot));
if (existsSync(web)) app.use(express.static(web));
if (existsSync(web)) app.get('/{*path}', (_req, res) => res.sendFile(path.join(web, 'index.html')));
// 只回收没有控制连接的会话；常驻使用的助手只要连接还在就不会被定时删除。
// 有连接的会话在连接关闭 10 秒后由 close 回调回收。
const cleanup = setInterval(() => {
  for (const [id, s] of sessions)
    if (!s.events.size && Date.now() - s.created > 5 * 60 * 1000) void remove(id);
}, 60000);
cleanup.unref();
server.listen(config.PORT, config.HOST, () => {
  const lan =
    config.HOST === '0.0.0.0'
      ? Object.values(networkInterfaces())
          .flat()
          .filter((n) => n && n.family === 'IPv4' && !n.internal)
          .map((n) => `http://${n!.address}:${config.PORT}`)
      : [];
  console.log(
    `超宝服务已启动：http://${config.HOST === '0.0.0.0' ? '127.0.0.1' : config.HOST}:${config.PORT}${lan.length ? `（局域网：${lan.join('、')}）` : ''}，Provider=${config.PROVIDER}，唤醒词=${config.WAKE_WORD}（${wakeTokens().join(' / ') || '本地唤醒不可用'}）`,
  );
});
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    server.close();
    void Promise.all([...sessions.keys()].map(remove)).finally(() => process.exit(0));
  });
