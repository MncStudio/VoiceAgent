'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn, execFile } = require('child_process');
const readline = require('readline');
const express = require('express');
const multer = require('multer');
const { WebSocketServer } = require('ws');
const config = require('./config');
// 配置引导模式:server/config/ 下没有可加载的配置(config.js 返回兜底 + __missing)。
// 此时只开静态页(配置生成器),控制台报错并打开网页;用户在页面上生成并下载 json,
// 放进 server/config/{名字}.json 后重新 npm start 即完成初始化。
const FIRST_RUN = config.__missing === true;
const audio = require('./audio');
const asr = require('./asr');
const vad = require('./vad');
const wake = require('./wake');
const tts = require('./tts');
const stream = require('./stream');
const { Timing } = require('./timing');
const os = require('os');

// 取本机局域网 IPv4(非回环),用于启动日志提示局域网访问地址;取不到返回 null。
function getLanAddress() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const it of ifaces || []) {
      if (it.family === 'IPv4' && !it.internal) return it.address;
    }
  }
  return null;
}

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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 }, // 单文件 ≤20MB,防大文件打爆内存
});

if (FIRST_RUN) {
  // 首次运行:根路径直接进配置生成页(须在 express.static 之前注册,否则 '/' 会被 index.html 抢占)
  app.get('/', (req, res) => res.redirect('/config-builder.html?first=1'));
}

app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- 宠物形象只读列表:列出 public/pets/*.{png,webp} 及其配对的 <名字>.json(供宠物页/演示页) ----
const PETS_DIR = path.join(__dirname, '..', 'public', 'pets');
app.get('/api/pets', (req, res) => {
  let files;
  try { files = fs.readdirSync(PETS_DIR); } catch { return res.json({ pets: [] }); }
  const pets = files
    .filter((f) => /\.(png|webp)$/i.test(f))
    .map((sp) => {
      const base = sp.replace(/\.[^.]+$/, '');
      const pair = files.find((f) => f.toLowerCase() === base.toLowerCase() + '.json');
      let meta = null;
      if (pair) { try { meta = JSON.parse(fs.readFileSync(path.join(PETS_DIR, pair), 'utf8')); } catch {} }
      return { name: base, sprite: sp, meta };
    });
  res.json({ pets });
});

app.post('/api/chat', upload.single('audio'), async (req, res) => {
  if (FIRST_RUN) {
    return res.status(503).json({
      error: '尚未生成配置:打开 /config-builder.html 生成并下载 local.json,放进 server/config/ 后重新 npm start',
    });
  }
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

    // 3. 语音两跳第一跳:只回识别文本,由前端连 /api/chat_stream 做 LLM→TTS 流式(不在这调 LLM)。
    res.json({ userText });
    t.log();
  } catch (err) {
    console.error('[chat]', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    audio.cleanup(inputPath, wavPath, vadOut);
  }
});

// 文字问答走 /api/chat_stream(WS 流式),不再有独立的非流式端点。

// 统一 JSON 错误响应(multer 超限等)
app.use((err, req, res, next) => {
  if (!err) return next();
  const msg = err.code === 'LIMIT_FILE_SIZE' ? '录音文件超过 20MB 限制' : err.message;
  res.status(400).json({ error: msg });
});

// 唤醒词检测:WebSocket,前端常驻推 16k int16 PCM 块,命中唤醒词回 {"type":"wake","word":...}
const server = http.createServer(app);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 端口被占用:先问一句,再决定要不要结束旧进程 ----
// VA_PORT_KILL=ask(默认,终端里交互询问) | yes(不问直接结束,给脚本/CI) | no(只报错退出)
const PORT_KILL_MODE = String(process.env.VA_PORT_KILL || 'ask').toLowerCase();

// 列出监听该端口的进程 PID(lsof / netstat,取不到返回空数组)
function listPortPids(port) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('netstat', ['-ano', '-p', 'TCP'], (err, stdout) => {
        if (err || !stdout) return resolve([]);
        const pids = [];
        for (const line of String(stdout).split(/\r?\n/)) {
          const cols = line.trim().split(/\s+/);
          if (cols.length < 5 || cols[3] !== 'LISTENING' || !cols[1].endsWith(`:${port}`)) continue;
          const pid = Number(cols[4]);
          if (Number.isInteger(pid) && pid > 0) pids.push(pid);
        }
        resolve([...new Set(pids)]);
      });
      return;
    }
    execFile('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], (err, stdout) => {
      const pids = String(stdout || '').split(/\s+/).map(Number)
        .filter((n) => Number.isInteger(n) && n > 0);
      resolve([...new Set(pids)]);
    });
  });
}

// 占用进程的命令行,便于用户判断该不该结束它
function describePid(pid) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') return resolve('');
    execFile('ps', ['-o', 'command=', '-p', String(pid)], (err, stdout) => resolve(String(stdout || '').trim()));
  });
}

// 终端里问 y/N;EOF / Ctrl-D 等关闭输入都按"不结束"处理
function askKillConfirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; rl.close(); resolve(v); } };
    rl.question(question, (answer) => done(/^(y|yes)$/i.test(String(answer).trim())));
    rl.on('close', () => done(false));
  });
}

// SIGTERM → 等端口释放(最多 2s)→ 仍占着就 SIGKILL → 再等 1s
async function killPortListeners(port) {
  const self = process.pid;
  for (const pid of (await listPortPids(port)).filter((p) => p !== self)) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  for (let i = 0; i < 20; i++) {
    await sleep(100);
    if (!(await listPortPids(port)).length) return true;
  }
  for (const pid of (await listPortPids(port)).filter((p) => p !== self)) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  for (let i = 0; i < 10; i++) {
    await sleep(100);
    if (!(await listPortPids(port)).length) return true;
  }
  return false;
}

// 端口占用时的完整处理:打印占用者 → 询问 → 结束旧进程 → 重新监听
async function handlePortInUse() {
  const port = config.server.port;
  console.error(`端口 ${port} 已被占用。`);
  const pids = await listPortPids(port);
  if (!pids.length) {
    console.error('  没能识别出占用进程(系统缺 lsof?),请手动停掉旧进程或改 server.port。');
    process.exit(1);
  }
  for (const pid of pids) {
    const cmd = await describePid(pid);
    console.error(`  占用中: PID ${pid}${cmd ? `  ${cmd}` : ''}`);
  }

  let kill = false;
  if (PORT_KILL_MODE === 'yes') {
    kill = true;
  } else if (PORT_KILL_MODE === 'no' || !process.stdin.isTTY) {
    console.error('  当前不是可交互终端(或 VA_PORT_KILL=no),没有结束任何进程;');
    console.error('  请手动停掉旧进程后重试,或改 server.port。');
    process.exit(1);
  } else {
    kill = await askKillConfirm('  结束上述进程并继续启动? [y/N] ');
  }
  if (!kill) {
    console.error('  已取消,没有结束任何进程。');
    process.exit(1);
  }
  if (!(await killPortListeners(port))) {
    console.error(`  进程已结束,但端口 ${port} 仍被占用,请手动排查后重试。`);
    process.exit(1);
  }
  console.log(`  端口 ${port} 已释放,继续启动…`);
  server.listen(config.server.port);
}

// 端口占用/监听失败:友好提示,避免 Node 裸崩。server 上先挂 handler(须早于 new WSS),
// wss 只转发同一个 error,所以它单独挂一个"忽略 EADDRINUSE"的兜底 handler,免得同一错误
// 触发两次询问/两次退出。
let portRetried = false;
const onListenError = (err) => {
  if (err.code === 'EADDRINUSE') {
    if (portRetried) {
      // 结束旧进程后又被别人抢走,别再问一遍,直接明确退出
      console.error(`端口 ${config.server.port} 释放后又被占用,请手动排查后重试。`);
      process.exit(1);
    }
    portRetried = true;
    handlePortInUse().catch((e) => { console.error('服务启动失败:', e.message); process.exit(1); });
    return;
  }
  console.error('服务启动失败:', err.message);
  process.exit(1);
};
server.on('error', onListenError);
const onWssError = (err) => {
  if (err.code === 'EADDRINUSE') return; // 已由 server 的 onListenError 处理
  console.error('服务启动失败:', err.message);
  process.exit(1);
};
// 共享一个 WebSocketServer(不带 path):wake 与 tts 的 path 各自在 connection 里过滤。
// 若分别用两个带 path 的 WSS 挂同一 server,先注册的会把不匹配请求直接回 400。
const wss = new WebSocketServer({ server });
wss.on('error', onWssError);
// 唤醒 / 流式问答 / 流式 TTS 都需要真实配置,首次运行(无配置)时不挂载,只留配置引导。
if (!FIRST_RUN) {
  wake.attach(wss, config.wakeWords || [], config.wakeTimeout, config.vad, config.wakeStopWords, config.wakeStopMaxLen, config.wakeRequireWord, config.wakeFollowUpTimeout, config.wakeFuzzyMatch !== false, config.wakeBargeIn !== false);
  // 流式问答:LLM 增量 → 断句 → 逐句 TTS → 顺序推 PCM。与 /api/wake、/api/tts 共用一个 WSS。
  stream.attach(wss);

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
}

function onListening() {
  if (FIRST_RUN) {
    // "没有就报错":明确告知缺哪个配置,再进入引导网页
    const miss = `server/config/${config.__profile}.json`;
    console.error('');
    console.error(`✗ 启动失败原因:没有可用配置 —— ${miss} 不存在`);
    if (config.__candidates && config.__candidates.length) {
      console.error(`  目录里现有配置:${config.__candidates.join(', ')}。`);
      console.error('  (把其中一份改名为 local.json,或 VA_PROFILE=<名字> npm start 显式指定)');
    }
    console.error('  已进入配置引导:打开网页 → 生成并下载 local.json → 放进 server/config/ → 重新 npm start。');
    console.error('');
    if (!process.env.VA_NO_OPEN) openBrowser(`http://localhost:${config.server.port}/`);
    console.log(`配置网页(备用): http://localhost:${config.server.port}/config-builder.html`);
    const lan = getLanAddress();
    if (lan) console.log(`局域网访问:    http://${lan}:${config.server.port}/`);
  } else {
    console.log(`VoiceAgent 已启动: http://localhost:${config.server.port}  (配置: ${config.__profile}.json · ${config.__profileSource})`);
    const lan = getLanAddress();
    if (lan) console.log(`局域网访问:    http://${lan}:${config.server.port}`);
    console.log('配置生成/修改:打开 /config-builder.html 生成并下载 local.json,替换 server/config/local.json 后重启进程生效(可直接 npm start)。');
  }
}

// 首次监听;端口被占用时由 handlePortInUse() 结束后再监听一次。
// 注意用常驻 'listening' 监听器,别用 listen(port, cb):cb 是 once,首次 EADDRINUSE
// 不会消费掉它,第二次 listen 会再注册一个,成功时启动横幅会打印两遍。
server.on('listening', onListening);
server.listen(config.server.port);

// 尝试用系统默认浏览器打开配置网页(macOS open / win start / linux xdg-open),失败静默。
function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd'
      : 'xdg-open';
  try {
    const child = process.platform === 'win32'
      ? spawn(cmd, ['/c', 'start', '', url], { detached: true, stdio: 'ignore' })
      : spawn(cmd, [url], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {}
}
