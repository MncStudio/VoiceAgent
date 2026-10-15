import WebSocket from 'ws';
import type { ASRProvider, ASRStream, TTSProvider, Transcript } from './types.js';
export class FunASR implements ASRProvider {
  constructor(private url: string) {}
  async open(
    onResult: (t: Transcript) => void,
    onError: (e: Error) => void,
    signal: AbortSignal,
  ): Promise<ASRStream> {
    const ws = new WebSocket(this.url, { handshakeTimeout: 10000 });
    const cancel = () => ws.close();
    signal.addEventListener('abort', cancel, { once: true });
    ws.on('close', () => signal.removeEventListener('abort', cancel));
    ws.on('error', () => onError(new Error('本地 FunASR 连接失败。')));
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
      ws.once('close', () => reject(new Error('FunASR 连接关闭。')));
    });
    signal.throwIfAborted();
    ws.send(
      JSON.stringify({
        mode: '2pass',
        chunk_size: [5, 10, 5],
        chunk_interval: 10,
        audio_fs: 16000,
        wav_name: 'chaobao',
        is_speaking: true,
        itn: true,
      }),
    );
    ws.on('message', (data) => {
      try {
        const r = JSON.parse(data.toString());
        if (r.text)
          onResult({ text: r.text, final: r.mode === '2pass-offline' || r.is_final === true });
      } catch {
        onError(new Error('FunASR 响应格式异常。'));
      }
    });
    return {
      write(pcm) {
        if (ws.readyState === WebSocket.OPEN) ws.send(pcm);
      },
      finish() {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ is_speaking: false }));
      },
      close() {
        ws.close();
      },
    };
  }
}
export class CosyVoiceLocal implements TTSProvider {
  constructor(
    private url: string,
    private voice: string,
  ) {}
  async *synth(text: string, signal: AbortSignal) {
    const form = new FormData();
    form.set('tts_text', text);
    form.set('spk_id', this.voice);
    const response = await fetch(this.url, {
      method: 'POST',
      body: form,
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    });
    if (!response.ok || !response.body)
      throw new Error(`本地 CosyVoice 接口失败（HTTP ${response.status}）。`);
    // 本项目约定网关输出 24kHz / int16 LE / mono 裸 PCM；其他模型版本须在网关重采样。
    for await (const chunk of response.body) {
      signal.throwIfAborted();
      yield Buffer.from(chunk);
    }
  }
}
