'use strict';

const fs = require('fs');
const config = require('./config');
const { asrWs } = require('./bailian');

// ASR:音频文件 → 识别文字。根据 profile 分流:
// - local  : 本地 Paraformer HTTP
// - online : 百炼 Paraformer WebSocket
async function recognize(wavPath) {
  if (config.asr.provider === 'paraformer-ws') {
    return asrWs(fs.readFileSync(wavPath));
  }

  // 本地 HTTP 实现
  const body = new FormData();
  body.append('file', new Blob([fs.readFileSync(wavPath)], { type: 'audio/wav' }), 'audio.wav');

  const res = await fetch(`${config.asr.url}${config.asr.endpoint}`, {
    method: 'POST',
    body,
    signal: AbortSignal.timeout(config.asr.timeoutMs),
  });

  if (!res.ok) {
    throw new Error(`ASR 请求失败: HTTP ${res.status}`);
  }

  const data = await res.json();
  const text = (data.text || '').trim();
  if (!text) {
    throw new Error('ASR 未识别到文字');
  }
  return text;
}

module.exports = { recognize };
