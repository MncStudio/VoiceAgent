'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const config = require('./config');
const audio = require('./audio');
const asr = require('./asr');
const llm = require('./llm');
const tts = require('./tts');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// 会话表:sessionId → context(语析存 threadId,DeepSeek 存消息历史)。
// 多轮记忆靠 context 复用。单实例内存够用;多实例部署时需换 redis/数据库。
const sessions = new Map();

app.use(express.static(path.join(__dirname, '..', 'public')));

app.post('/api/chat', upload.single('audio'), async (req, res) => {
  const inputPath = audio.tempPath('.webm');
  let wavPath = null;

  try {
    if (!req.file) {
      return res.status(400).json({ error: '缺少 audio 文件' });
    }

    // 1. 浏览器录音(webm/mp4)转成 ASR 需要的 wav
    fs.writeFileSync(inputPath, req.file.buffer);
    const wav = await audio.transcodeToWav(inputPath);
    wavPath = wav;

    // 2. ASR:音频 → 文字
    const userText = await asr.recognize(wav);

    // 3. LLM:文字 → 回复(带多轮上下文)
    const sessionId = req.body.sessionId;
    const context = sessions.get(sessionId);
    const { text: replyText, context: newContext } = await llm.ask(userText, context);
    if (sessionId) {
      sessions.set(sessionId, newContext);
    }

    // 4. TTS:回复 → wav 音频
    const wavAudio = await tts.synthesize(replyText);

    res.json({ replyText, userText, wavAudio: wavAudio.toString('base64') });
  } catch (err) {
    console.error('[chat]', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    audio.cleanup(inputPath, wavPath);
  }
});

app.listen(config.server.port, () => {
  console.log(`VoiceAgent 已启动: http://localhost:${config.server.port}`);
});
