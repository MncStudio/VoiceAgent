import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { speechProxy } from '../net.js';
import { AsyncQueue } from './queue.js';
import type { ASRProvider, ASRStream, TTSProvider, Transcript } from './types.js';
type Packet = {
  header: { event?: string; error_code?: string };
  payload?: { output?: { sentence?: { text?: string; sentence_end?: boolean } } };
};
function connect(url: string, key: string, signal?: AbortSignal) {
  return new Promise<WebSocket>((resolve, reject) => {
    signal?.throwIfAborted();
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${key}` },
      handshakeTimeout: 10000,
      agent: speechProxy,
    });
    if (signal) bindAbort(ws, signal);
    ws.once('open', () => resolve(ws));
    ws.once('error', () => reject(new Error('百炼语音连接失败，请检查网络、地域和密钥。')));
    ws.once('close', () => reject(new Error('语音连接已关闭。')));
  });
}
function bindAbort(ws: WebSocket, signal: AbortSignal) {
  const cancel = () => ws.close();
  signal.addEventListener('abort', cancel, { once: true });
  ws.once('close', () => signal.removeEventListener('abort', cancel));
}
/**
 * 预热连接：在用户开口 / 开始回答时提前完成 WebSocket 握手，真正需要时直接取用。
 * 每次只保留一个空闲连接，超过 30 秒未使用就丢弃重连，避免拿到被服务端回收的连接。
 */
class WarmSocket {
  private spare?: { ws: WebSocket; at: number };
  private pending?: Promise<void>;
  constructor(
    private url: string,
    private key: string,
  ) {}
  private fresh() {
    return (
      !!this.spare &&
      this.spare.ws.readyState === WebSocket.OPEN &&
      Date.now() - this.spare.at < 30000
    );
  }
  warm() {
    if (this.pending || this.fresh()) return;
    this.spare?.ws.close();
    this.spare = undefined;
    this.pending = connect(this.url, this.key)
      .then((ws) => {
        ws.on('error', () => {});
        ws.once('close', () => {
          if (this.spare?.ws === ws) this.spare = undefined;
        });
        this.spare = { ws, at: Date.now() };
      })
      .catch(() => {})
      .finally(() => {
        this.pending = undefined;
      });
  }
  async take(signal: AbortSignal) {
    if (!this.fresh() && this.pending) await this.pending;
    signal.throwIfAborted();
    const spare = this.fresh() ? this.spare : undefined;
    this.spare = undefined;
    if (spare) {
      bindAbort(spare.ws, signal);
      return spare.ws;
    }
    return connect(this.url, this.key, signal);
  }
  close() {
    this.spare?.ws.close();
    this.spare = undefined;
  }
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
    private maxSentenceSilence = 0,
  ) {
    this.socket = new WarmSocket(url, key);
  }
  private socket: WarmSocket;
  warm() {
    this.socket.warm();
  }
  close() {
    this.socket.close();
  }
  async open(
    onResult: (v: Transcript) => void,
    onError: (e: Error) => void,
    signal: AbortSignal,
  ): Promise<ASRStream> {
    const ws = await this.socket.take(signal);
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
        // VAD 断句静音阈值：交互场景调短，句子更快给出 final 结果（仅 v2 模型支持）。
        ...(this.maxSentenceSilence && /v2/u.test(this.model)
          ? { max_sentence_silence: this.maxSentenceSilence }
          : {}),
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
  ) {
    this.socket = new WarmSocket(url, key);
  }
  private socket: WarmSocket;
  warm() {
    this.socket.warm();
  }
  close() {
    this.socket.close();
  }
  async *synth(text: string, signal: AbortSignal) {
    const ws = await this.socket.take(signal);
    // 同一轮回答的下一句通常紧接着需要连接，提前预热。
    this.socket.warm();
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
