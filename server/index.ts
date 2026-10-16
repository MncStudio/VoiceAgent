import express from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from './config.js';
import { Conversation } from './engine.js';
import { createProviders } from './providers/index.js';
import { clientEventSchema, type ServerEvent } from '../shared/protocol.js';
import { joinAgent, token } from './livekit.js';
import { SemanticPolicy } from './semantic.js';
import { OpenAILLM } from './providers/llm.js';
const app = express();
const server = createServer(app);
const allowed = new Set(config.ALLOWED_ORIGINS.split(','));
app.disable('x-powered-by');
app.use(express.json({ limit: '8kb' }));
app.use((req, res, next) => {
  if (req.headers.origin && !allowed.has(req.headers.origin)) {
    res.status(403).json({ error: '不允许的来源。' });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
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
app.get('/api/health', (_req, res) => res.json({ ok: true, provider: config.PROVIDER }));
app.get('/api/config', (_req, res) =>
  res.json({
    provider: config.PROVIDER,
    qaProvider: config.PROVIDER === 'demo' ? 'demo' : config.QA_PROVIDER,
    wakeWord: config.WAKE_WORD,
    wakeAck: config.WAKE_ACK,
    followupMs: config.FOLLOWUP_MS,
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
app.post('/api/sessions', (_req, res) => {
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
      followupMs: config.FOLLOWUP_MS,
      speakerReject: Math.max(0, config.SPEAKER_THRESHOLD - 0.15),
      semantic,
      speculative: config.QA_PROVIDER !== 'yuxi' && config.SPECULATIVE === 'true',
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
  if (
    url.pathname !== '/control' ||
    !sessions.has(id) ||
    !req.headers.origin ||
    !allowed.has(req.headers.origin)
  ) {
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
const web = path.resolve('dist/web');
if (existsSync(web)) {
  app.use(express.static(web));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(web, 'index.html')));
}
// 只回收没有控制连接的会话；常驻使用的助手只要连接还在就不会被定时删除。
// 有连接的会话在连接关闭 10 秒后由 close 回调回收。
const cleanup = setInterval(() => {
  for (const [id, s] of sessions)
    if (!s.events.size && Date.now() - s.created > 5 * 60 * 1000) void remove(id);
}, 60000);
cleanup.unref();
server.listen(config.PORT, config.HOST, () =>
  console.log(`超宝服务已启动：http://${config.HOST}:${config.PORT}，Provider=${config.PROVIDER}`),
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    server.close();
    void Promise.all([...sessions.keys()].map(remove)).finally(() => process.exit(0));
  });
