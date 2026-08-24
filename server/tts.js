'use strict';

const config = require('./config');
const { ttsWsStream } = require('./bailian');

// 本地 CosyVoice HTTP:文本 → onChunk 流式回调 PCM 块(裸 s16le,参数见 config.tts)。
// 声音用 spk_id 引用——用 scripts/tts-admin.html 页面把参考音频注册到 TTS 服务,
// 再把 spk_id 配进 config.tts.spkId,主链路只发 tts_text + spk_id(不碰参考文件)。
// 服务端 stream=true 按 chunked 流式推 PCM,这里读响应体流逐块透传。
// 返回 { promise, cancel }:cancel 供打断时中止请求,停止合成。
function localHttpTts(text, onChunk) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.tts.timeoutMs);

  const promise = (async () => {
    const body = new FormData();
    body.append('tts_text', text);
    body.append('spk_id', config.tts.spkId);
    body.append('stream', 'true');

    const res = await fetch(`${config.tts.url}${config.tts.endpoint}`, {
      method: 'POST',
      body,
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`TTS 请求失败: HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    let total = 0;
    let pending = Buffer.alloc(0); // 跨块对齐:服务端流式块不保证 2 字节对齐(s16le 每采样 2 字节)
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) {
        total += value.length;
        pending = Buffer.concat([pending, Buffer.from(value)]);
        const usable = pending.length & ~1; // 对齐到偶数,避免前端 Int16Array 解析崩溃
        if (usable) {
          onChunk(pending.subarray(0, usable));
          pending = pending.subarray(usable);
        }
      }
    }
    if (total === 0) throw new Error('TTS 返回空音频');
    // 尾部残留的不足 2 字节奇数位丢弃,不影响可听内容
  })().finally(() => clearTimeout(timeout));

  return { promise, cancel: () => { clearTimeout(timeout); controller.abort(); } };
}

// 流式 TTS:文本 → onChunk 逐个回调 PCM 块(裸 s16le,参数见 config.tts)。
// 返回 { promise, cancel }:cancel 供打断时停止合成。
// - online:百炼 WS 真流式,每收到一块就回调。
// - local :本地 CosyVoice HTTP 流式(chunked),逐块透传,打断时 abort 请求。
function synthesizeStream(text, onChunk) {
  if (config.tts.provider === 'cosyvoice-ws') {
    return ttsWsStream(text, onChunk);
  }
  return localHttpTts(text, onChunk);
}

module.exports = { synthesizeStream };
