import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { speechProxy } from '../net.js';
import { AsyncQueue } from './queue.js';
import type { ASRProvider, ASRStream, TTSProvider, Transcript } from './types.js';
type Packet = {
  header: { event?: string; error_code?: string };
  payload?: { output?: { sentence?: { text?: string; sentence_end?: boolean } } };
};
function connect(url: string, key: string, signal: AbortSignal) {
  return new Promise<WebSocket>((resolve, reject) => {
    signal.throwIfAborted();
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${key}` },
      handshakeTimeout: 10000,
      agent: speechProxy,
    });
    const cancel = () => ws.close();
    signal.addEventListener('abort', cancel, { once: true });
    ws.once('close', () => signal.removeEventListener('abort', cancel));
    ws.once('open', () => resolve(ws));
    ws.once('error', () => reject(new Error('百炼语音连接失败，请检查网络、地域和密钥。')));
    ws.once('close', () => reject(new Error('语音连接已关闭。')));
  });
}
function command(ws: WebSocket, id: string, action: string, payload: object) {
  if (ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ header: { action, task_id: id, streaming: 'duplex' }, payload }));
}
export class DashScopeASR implements ASRProvider {
  constructor(
    private url: string,
    private key: string,
    private model: string,
    private vocabularyId = '',
  ) {}
  async open(
    onResult: (v: Transcript) => void,
    onError: (e: Error) => void,
    signal: AbortSignal,
  ): Promise<ASRStream> {
    const ws = await connect(this.url, this.key, signal);
    const id = randomUUID();
    let ready = false,
      finished = false,
      closed = false;
    const pending: Buffer[] = [];
    let pendingBytes = 0;
    const deadline = setTimeout(() => {
      onError(new Error('ASR 启动超时。'));
      ws.close();
    }, 15000);
    ws.on('message', (data, binary) => {
      if (binary) return;
      try {
        const event = JSON.parse(data.toString()) as Packet;
        switch (event.header.event) {
          case 'task-started':
            clearTimeout(deadline);
            ready = true;
            pending.forEach((p) => ws.send(p));
            pending.length = 0;
            pendingBytes = 0;
            if (finished) command(ws, id, 'finish-task', { input: {} });
            break;
          case 'result-generated': {
            const s = event.payload?.output?.sentence;
            if (s?.text) onResult({ text: s.text, final: !!s.sentence_end });
            break;
          }
          case 'task-failed':
            onError(new Error(`ASR 服务拒绝请求（${event.header.error_code ?? 'unknown'}）。`));
            ws.close();
            break;
          case 'task-finished':
            ws.close();
            break;
        }
      } catch {
        onError(new Error('ASR 返回无法解析的数据。'));
        ws.close();
      }
    });
    ws.on('error', () => onError(new Error('ASR 网络异常。')));
    ws.on('close', () => {
      clearTimeout(deadline);
      if (!closed && !finished && !signal.aborted) onError(new Error('ASR 连接意外断开。'));
    });
    command(ws, id, 'run-task', {
      task_group: 'audio',
      task: 'asr',
      function: 'recognition',
      model: this.model,
      parameters: {
        format: 'pcm',
        sample_rate: 16000,
        ...(this.vocabularyId ? { vocabulary_id: this.vocabularyId } : {}),
      },
      input: {},
    });
    return {
      write(pcm) {
        if (finished || closed) return;
        if (ready && ws.readyState === WebSocket.OPEN) {
          if (ws.bufferedAmount > 320000) {
            onError(new Error('ASR 网络积压，请重试。'));
            ws.close();
          } else ws.send(pcm);
        } else if (pendingBytes + pcm.length <= 320000) {
          pending.push(pcm);
          pendingBytes += pcm.length;
        }
      },
      finish() {
        if (finished) return;
        finished = true;
        if (ready) command(ws, id, 'finish-task', { input: {} });
      },
      close() {
        closed = true;
        clearTimeout(deadline);
        ws.close();
      },
    };
  }
}
export class DashScopeTTS implements TTSProvider {
  constructor(
    private url: string,
    private key: string,
    private model: string,
    private voice: string,
  ) {}
  async *synth(text: string, signal: AbortSignal) {
    const ws = await connect(this.url, this.key, signal);
    const id = randomUUID();
    const queue = new AsyncQueue<Buffer>();
    let done = false;
    let bytes = 0;
    const timeout = setTimeout(() => {
      queue.end(new Error('TTS 合成超时。'));
      ws.close();
    }, 30000);
    ws.on('message', (data, binary) => {
      if (binary) {
        const pcm = Buffer.from(data as Buffer);
        bytes += pcm.length;
        if (bytes > 8_000_000) {
          queue.end(new Error('TTS 音频过长。'));
          ws.close();
        } else queue.push(pcm);
        return;
      }
      try {
        const event = JSON.parse(data.toString()) as Packet;
        if (event.header.event === 'task-started') {
          command(ws, id, 'continue-task', { input: { text } });
          command(ws, id, 'finish-task', { input: {} });
        } else if (event.header.event === 'task-finished') {
          done = true;
          queue.end();
          ws.close();
        } else if (event.header.event === 'task-failed') {
          queue.end(new Error(`TTS 服务拒绝请求（${event.header.error_code ?? 'unknown'}）。`));
          ws.close();
        }
      } catch {
        queue.end(new Error('TTS 返回无法解析的数据。'));
        ws.close();
      }
    });
    ws.on('error', () => queue.end(new Error('TTS 网络异常。')));
    ws.on('close', () =>
      queue.end(done || signal.aborted ? undefined : new Error('TTS 连接意外断开。')),
    );
    command(ws, id, 'run-task', {
      task_group: 'audio',
      task: 'tts',
      function: 'SpeechSynthesizer',
      model: this.model,
      parameters: {
        text_type: 'PlainText',
        voice: this.voice,
        format: 'pcm',
        sample_rate: 24000,
        volume: 50,
        rate: 1,
        pitch: 1,
      },
      input: {},
    });
    try {
      for await (const pcm of queue) {
        signal.throwIfAborted();
        yield pcm;
      }
    } finally {
      clearTimeout(timeout);
      ws.close();
    }
  }
}
