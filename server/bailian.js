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

// 百炼 TTS:流式合成。text → 每个 PCM 块调 onChunk(Buffer)。返回 { promise, cancel }。
// cancel() 供前端打断时关掉底层百炼 WS,停止生成。
function ttsWsStream(text, onChunk) {
  let ws = null;
  const promise = new Promise((resolve, reject) => {
    const taskId = newTaskId();
    ws = new WebSocket(config.tts.url, bailianOptions());
    const timeoutMs = config.tts.timeoutMs;
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
      else resolve();
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
        onChunk(Buffer.from(data));
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
  return { promise, cancel: () => { try { ws && ws.close(); } catch {} } };
}

module.exports = { asrWs, ttsWsStream };
