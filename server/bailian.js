'use strict';

const WebSocket = require('ws');
const crypto = require('crypto');
const config = require('./config');

// 百炼 WebSocket 公共客户端。协议:
// run-task → (ASR: 发二进制音频 / TTS: continue-task 发文本) → finish-task → task-finished
// 鉴权在握手阶段,通过 Authorization header。

function bailianOptions() {
  return { headers: { Authorization: `Bearer ${config.tts.apiKey || config.asr.apiKey}` } };
}

function newTaskId() {
  return crypto.randomUUID();
}

function sendJson(ws, action, taskId, payload) {
  ws.send(JSON.stringify({
    header: { action, task_id: taskId, streaming: 'duplex' },
    payload,
  }));
}

// 百炼 ASR:wav 文件 → 识别文字(取所有 sentence_end=true 的最终句)
function asrWs(wavBuffer) {
  return new Promise((resolve, reject) => {
    const taskId = newTaskId();
    const ws = new WebSocket(config.asr.url, bailianOptions());
    const timeoutMs = config.asr.timeoutMs;
    const finals = [];
    let started = false;
    let finished = false;

    const timeout = setTimeout(() => {
      finish(new Error(`百炼 ASR 超时(${timeoutMs}ms)`));
    }, timeoutMs);

    function finish(err) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      try { ws.close(); } catch {}
      if (err) reject(err);
      else resolve(finals.join(''));
    }

    ws.on('open', () => {
      sendJson(ws, 'run-task', taskId, {
        task_group: 'audio',
        task: 'asr',
        function: 'recognition',
        model: config.asr.model,
        parameters: { format: config.asr.format, sample_rate: config.asr.sampleRate },
        input: {},
      });
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(data.toString());
      const evt = msg.header?.event;

      if (evt === 'task-started' && !started) {
        started = true;
        ws.send(wavBuffer); // 一次性发完整 wav
        sendJson(ws, 'finish-task', taskId, { input: {} });
      } else if (evt === 'result-generated') {
        const s = msg.payload?.output?.sentence;
        if (s?.text && s.sentence_end) finals.push(s.text);
      } else if (evt === 'task-finished') {
        finish();
      } else if (evt === 'task-failed') {
        finish(new Error(`百炼 ASR 失败: ${msg.header?.error_code}: ${msg.header?.error_message}`));
      }
    });

    ws.on('error', (e) => finish(new Error(`百炼 ASR 连接错误: ${e.message}`)));
    ws.on('close', () => { if (!finished) finish(); });
  });
}

// 百炼 TTS:文本 → 完整 wav Buffer(服务端返回 pcm,这里包 wav 头)
function ttsWs(text) {
  return new Promise((resolve, reject) => {
    const taskId = newTaskId();
    const ws = new WebSocket(config.tts.url, bailianOptions());
    const timeoutMs = config.tts.timeoutMs;
    const pcmChunks = [];
    let started = false;
    let finished = false;

    const timeout = setTimeout(() => {
      finish(new Error(`百炼 TTS 超时(${timeoutMs}ms)`));
    }, timeoutMs);

    function finish(err) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      try { ws.close(); } catch {}
      if (err) reject(err);
      else resolve(pcmToWav(Buffer.concat(pcmChunks)));
    }

    ws.on('open', () => {
      sendJson(ws, 'run-task', taskId, {
        task_group: 'audio',
        task: 'tts',
        function: 'SpeechSynthesizer',
        model: config.tts.model,
        parameters: {
          text_type: 'PlainText',
          voice: config.tts.voice,
          format: config.tts.format,
          sample_rate: config.tts.sampleRate,
        },
        input: {},
      });
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        pcmChunks.push(Buffer.from(data));
        return;
      }
      const msg = JSON.parse(data.toString());
      const evt = msg.header?.event;

      if (evt === 'task-started' && !started) {
        started = true;
        sendJson(ws, 'continue-task', taskId, { input: { text } });
        sendJson(ws, 'finish-task', taskId, { input: {} });
      } else if (evt === 'task-finished') {
        finish();
      } else if (evt === 'task-failed') {
        finish(new Error(`百炼 TTS 失败: ${msg.header?.error_code}: ${msg.header?.error_message}`));
      }
    });

    ws.on('error', (e) => finish(new Error(`百炼 TTS 连接错误: ${e.message}`)));
    ws.on('close', () => { if (!finished) finish(); });
  });
}

// 裸 PCM(s16le) → wav。参数与 config.tts 一致:24k / mono / 16bit。
function pcmToWav(pcm) {
  const { sampleRate, channels, bitsPerSample } = config.tts;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const dataSize = pcm.length;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  pcm.copy(buf, 44);

  return buf;
}

module.exports = { asrWs, ttsWs, pcmToWav };
