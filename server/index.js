'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const multer = require('multer');
const { WebSocketServer } = require('ws');
const config = require('./config');
const audio = require('./audio');
const asr = require('./asr');
const vad = require('./vad');
const turn = require('./turn');
const wake = require('./wake');
const tts = require('./tts');
const { Timing } = require('./timing');

const app = express();

// CORS:跨域部署时(别的项目经 baseUrl 独立域名/端口调用)浏览器需要后端放行。
// 默认放开所有来源;要收紧就改成具体域名列表。
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204); // 预检请求直接放行
  next();
});

const upload = multer({ storage: multer.memoryStorage() });
app.use(express.json());

app.use(express.static(path.join(__dirname, '..', 'public')));

app.post('/api/chat', upload.single('audio'), async (req, res) => {
  const inputPath = audio.tempPath('.webm');
  let wavPath = null;
  let vadOut = null;

  try {
    if (!req.file) {
      return res.status(400).json({ error: '缺少 audio 文件' });
    }

    // 1. 浏览器录音(webm/mp4)转成 ASR 需要的 wav
    fs.writeFileSync(inputPath, req.file.buffer);
    const t = new Timing('chat');
    const wav = await audio.transcodeToWav(inputPath);
    t.mark('转码');
    wavPath = wav;

    // 2. VAD:裁掉首尾静音,只把有效语音送给 ASR
    vadOut = await vad.trimSilence(wav);
    t.mark('VAD');

    // 3. ASR:音频 → 文字
    const userText = await asr.recognize(vadOut);
    t.mark('ASR');

    // 3. LLM 出文本(音频由前端 /api/tts 流式合成,边生成边播)
    res.json(await turn.ask(userText, req.body.sessionId));
    t.mark('LLM');
    t.log();
  } catch (err) {
    console.error('[chat]', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    audio.cleanup(inputPath, wavPath, vadOut);
  }
});

// 文字接口:跳过转码/VAD/ASR,直接 LLM。请求体 JSON { text, sessionId }。
app.post('/api/chat_text', (req, res) => {
  (async () => {
    const text = String(req.body?.text || '').trim();
    if (!text) {
      return res.status(400).json({ error: '缺少 text' });
    }
    res.json(await turn.ask(text, req.body?.sessionId));
  })().catch((err) => {
    console.error('[chat_text]', err.message);
    res.status(500).json({ error: err.message });
  });
});

// 唤醒词检测:WebSocket,前端常驻推 16k int16 PCM 块,命中唤醒词回 {"type":"wake","word":...}
const server = http.createServer(app);
// 共享一个 WebSocketServer(不带 path):wake 与 tts 的 path 各自在 connection 里过滤。
// 若分别用两个带 path 的 WSS 挂同一 server,先注册的会把不匹配请求直接回 400。
const wss = new WebSocketServer({ server });
wake.attach(wss, config.wakeWords || [], config.wakeTimeout, config.vad);

// 流式 TTS:前端拿 replyText 后连 /api/tts 发 {type:'synthesize', text},
// 后端先回 {type:'meta', sampleRate, channels, bitsPerSample},再逐个透传 PCM 二进制块(裸 s16le),
// 最后回 {type:'done'} 结束。前端打断时直接 close,后端停止合成。
wss.on('connection', (ws, req) => {
  if (new URL(req.url, 'http://localhost').pathname !== '/api/tts') return;
  let active = null; // synthesizeStream 返回的 { promise, cancel }
  ws.on('close', () => {
    if (active) {
      active.cancel();
      active = null;
    }
  });
  ws.on('message', (data, isBinary) => {
    if (isBinary || active) return;
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type !== 'synthesize' || !msg.text) return;
    const text = String(msg.text).trim();
    if (!text) return;

    const t = new Timing('tts');
    let first = true;
    ws.send(JSON.stringify({
      type: 'meta',
      sampleRate: config.tts.sampleRate,
      channels: config.tts.channels,
      bitsPerSample: config.tts.bitsPerSample,
    }));
    active = tts.synthesizeStream(text, (chunk) => {
      if (ws.readyState !== ws.OPEN) return;
      if (first) { t.mark('首块'); first = false; }
      ws.send(chunk);
    });
    active.promise
      .then(() => {
        if (first) t.mark('首块'); // 无音频块(异常空返回)也收尾
        t.mark('完成');
        t.log();
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'done' }));
      })
      .catch((e) => {
        console.error('[tts]', e.message);
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'error', message: e.message }));
      })
      .finally(() => { active = null; });
  });
});

server.listen(config.server.port, () => {
  console.log(`VoiceAgent 已启动: http://localhost:${config.server.port}`);
});
