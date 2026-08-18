'use strict';

const config = require('./config');
const { ttsWsStream } = require('./bailian');

// 本地 CosyVoice HTTP:文本 → 裸 PCM(一次性整段,无流式)。
async function localHttpTts(text) {
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
  return pcm;
}

// 流式 TTS:文本 → onChunk 逐个回调 PCM 块(裸 s16le,参数见 config.tts)。
// 返回 { promise, cancel }:cancel 供打断时停止合成。
// - online:百炼 WS 真流式,每收到一块就回调。
// - local :HTTP 一次性返回,单块回调(兼容前端流式播放器)。
function synthesizeStream(text, onChunk) {
  if (config.tts.provider === 'cosyvoice-ws') {
    return ttsWsStream(text, onChunk);
  }
  return {
    promise: localHttpTts(text).then((pcm) => onChunk(pcm)),
    cancel: () => {},
  };
}

module.exports = { synthesizeStream };
