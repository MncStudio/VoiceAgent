'use strict';

const config = require('./config');
const { ttsWs } = require('./bailian');

// TTS:文本 → wav 音频。根据 profile 分流:
// - local  : 本地 CosyVoice HTTP
// - online : 百炼 CosyVoice WebSocket
async function synthesize(text) {
  if (config.tts.provider === 'cosyvoice-ws') {
    return ttsWs(text);
  }

  // 本地 HTTP 实现
  const body = new FormData();
  body.append('tts_text', text);
  body.append('spk_id', config.tts.spkId);

  const res = await fetch(`${config.tts.url}${config.tts.endpoint}`, {
    method: 'POST',
    body,
    signal: AbortSignal.timeout(config.tts.timeoutMs),
  });

  if (!res.ok) {
    throw new Error(`TTS 请求失败: HTTP ${res.status}`);
  }

  const pcm = Buffer.from(await res.arrayBuffer());
  if (pcm.length === 0) {
    throw new Error('TTS 返回空音频');
  }

  return pcmToWav(pcm);
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
  buf.writeUInt32LE(16, 16); // fmt chunk 大小
  buf.writeUInt16LE(1, 20); // PCM
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

module.exports = { synthesize };
