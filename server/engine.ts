import { randomUUID } from 'node:crypto';
import type { AssistantState, ClientEvent, Message, ServerEvent } from '../shared/protocol.js';
import type { Providers, ASRStream } from './providers/types.js';
import { AudioRing, estimatedMarks, incomplete, isBackchannel, stripWake } from './audio.js';
import type { SemanticPolicy } from './semantic.js';
import { AsyncQueue } from './providers/queue.js';
export interface AudioOutput {
  write(pcm: Buffer, signal: AbortSignal): Promise<void>;
  drain(): Promise<void>;
  clear(): void;
}
export class Conversation {
  state: AssistantState = 'IDLE';
  readonly ring = new AudioRing();
  readonly history: Message[] = [];
  private generation = 0;
  private abort = new AbortController();
  private asr?: ASRStream;
  private asrReady?: Promise<void>;
  private pendingAudio: Buffer[] = [];
  private transcript = '';
  private committed = '';
  private candidate = false;
  private barge = false;
  private turnId?: string;
  private answer = '';
  private heardChars = 0;
  private followupUntil = 0;
  private endpoint?: ReturnType<typeof setTimeout>;
  private timeout?: ReturnType<typeof setTimeout>;
  private duckTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private processing = Promise.resolve();
  private speechAt = 0;
  private userSpeaking = false;
  private recognizerEpoch = 0;
  private speakerLocked = false;
  private speakerMatch = false;
  private followupListening = false;
  private decisionEpoch = 0;
  private decisionAbort?: AbortController;
  private speculative?: { text: string; queue: AsyncQueue<string>; abort: AbortController };
  private speculationTimer?: ReturnType<typeof setTimeout>;
  constructor(
    private p: Providers,
    private emit: (e: ServerEvent) => void,
    private opts: {
      wakeWord: string;
      followupMs: number;
      semantic?: SemanticPolicy;
      speculative?: boolean;
    },
    private audio?: AudioOutput,
  ) {}
  attachAudio(audio: AudioOutput) {
    this.audio = audio;
  }
  private setState(state: AssistantState) {
    this.state = state;
    this.emit({ type: 'state', state, followupUntil: this.followupUntil });
  }
  handle(event: ClientEvent) {
    // Stop/cancel must never sit behind a slow network operation.
    if (event.type === 'interrupt') {
      this.interrupt(event.reason, event.heardChars);
      return;
    }
    if (event.type === 'playback') {
      if (event.turnId === this.turnId)
        this.heardChars = Math.max(this.heardChars, Math.min(event.heardChars, this.answer.length));
      return;
    }
    if (event.type === 'vad') {
      this.vad(event.speaking, event.target);
      return;
    }
    if (event.type === 'speaker') {
      this.speakerLocked = event.locked;
      this.speakerMatch = event.match;
      return;
    }
    this.processing = this.processing
      .then(async () => {
        if (this.disposed) return;
        if (event.type === 'reset') {
          this.cancel();
          this.history.length = 0;
          this.answer = '';
          this.turnId = undefined;
          this.heardChars = 0;
          this.transcript = '';
          this.committed = '';
          this.ring.clear();
          this.followupUntil = 0;
          this.setState('IDLE');
        }
        if (event.type === 'wake') await this.wake(event.source);
        if (event.type === 'text') {
          this.cancel();
          this.transcript = event.text;
          void this.respond(event.text);
        }
      })
      .catch((error) => this.fail(error));
  }
  ingest(pcm: Buffer) {
    this.ring.push(pcm);
    if (this.asr) this.asr.write(pcm);
    else if (this.asrReady && this.pendingAudio.length < 150)
      this.pendingAudio.push(Buffer.from(pcm));
  }
  private cancel() {
    this.generation++;
    this.abort.abort();
    this.abort = new AbortController();
    this.recognizerEpoch++;
    this.asr?.close();
    this.asr = undefined;
    this.asrReady = undefined;
    this.pendingAudio = [];
    clearTimeout(this.endpoint);
    clearTimeout(this.timeout);
    clearTimeout(this.duckTimer);
    clearTimeout(this.speculationTimer);
    this.abortSpeculation();
    this.decisionAbort?.abort();
    this.decisionEpoch++;
    this.audio?.clear();
    this.emit({ type: 'duck', active: false });
    this.candidate = false;
    this.barge = false;
    this.followupListening = false;
  }
  private retainHeard() {
    if (this.turnId && this.answer) {
      const heard = this.answer.slice(0, this.heardChars);
      if (heard) this.history.push({ role: 'assistant', content: heard });
    }
    this.answer = '';
    this.turnId = undefined;
    this.heardChars = 0;
  }
  private interrupt(reason: string, heard?: number) {
    if (heard !== undefined) this.heardChars = Math.min(heard, this.answer.length);
    const turnId = this.turnId,
      heardChars = this.heardChars;
    this.cancel();
    this.retainHeard();
    this.followupUntil = 0;
    this.emit({ type: 'interrupted', turnId, heardChars });
    this.setState('INTERRUPT');
    if (reason === 'stop' || reason === 'pause') {
      this.setState('IDLE');
      return;
    }
    this.setState('LISTENING');
    void this.listen(false, false, reason === 'wake' ? 3000 : 700).catch((e) => this.fail(e));
  }
  private async wake(source: 'button' | 'kws') {
    if (this.state === 'SPEAKING' || this.state === 'THINKING') {
      if (source === 'button') {
        this.interrupt('wake');
        return;
      }
      // KWS 候选先静音，复核失败恢复；不让候选直接污染历史。
      this.emit({ type: 'duck', active: true });
      this.candidate = true;
      if (!this.asr && !this.asrReady) await this.listen(true, true);
      return;
    }
    this.cancel();
    this.followupUntil = 0;
    this.candidate = source === 'kws';
    this.setState(this.candidate ? 'CANDIDATE' : 'LISTENING');
    if (this.p.demo) {
      this.setState('LISTENING');
      this.emit({ type: 'notice', message: '演示模式：请在下方输入文字。' });
      return;
    }
    await this.listen(source === 'kws');
  }
  private async listen(verify: boolean, keepGeneration = false, preRollMs = 700) {
    if (this.p.demo) return;
    this.asr?.close();
    this.asr = undefined;
    const recognizerEpoch = ++this.recognizerEpoch;
    this.transcript = '';
    this.committed = '';
    const generation = this.generation,
      signal = this.abort.signal;
    const initial = this.ring.snapshot();
    this.pendingAudio = [];
    this.asrReady = (async () => {
      const stream = await this.p.asr.open(
        (result) => {
          if (
            generation !== this.generation ||
            signal.aborted ||
            recognizerEpoch !== this.recognizerEpoch
          )
            return;
          const raw = result.text;
          if (verify && this.candidate) {
            if (!raw.replace(/[\s，。！？、]/gu, '').includes(this.opts.wakeWord)) return;
            this.candidate = false;
            if (keepGeneration) {
              this.interrupt('wake');
              this.emit({ type: 'wake-confirmed' });
              return;
            }
            this.setState('LISTENING');
            this.emit({ type: 'wake-confirmed' });
            this.emit({ type: 'notice', message: '我在，请说。' });
            clearTimeout(this.timeout);
            this.timeout = setTimeout(() => this.finishListening(), 12000);
          }
          if (this.barge) {
            if (isBackchannel(raw)) {
              this.finishBarge();
              return;
            }
            this.interrupt('speech');
            this.transcript = raw;
            this.committed = result.final ? raw : '';
            this.emit({ type: 'transcript', text: raw, final: false });
            this.scheduleEndpoint(raw);
            return;
          }
          const clean = stripWake(raw, this.opts.wakeWord);
          this.transcript = this.committed + clean;
          if (result.final) this.committed = this.transcript;
          if (this.transcript) {
            this.emit({ type: 'transcript', text: this.transcript, final: false });
            if (!this.userSpeaking) this.scheduleEndpoint(this.transcript);
          }
        },
        (error) => {
          if (generation === this.generation && recognizerEpoch === this.recognizerEpoch)
            this.fail(error);
        },
        signal,
      );
      if (
        generation !== this.generation ||
        signal.aborted ||
        recognizerEpoch !== this.recognizerEpoch
      ) {
        stream.close();
        return;
      }
      this.asr = stream;
      stream.write(verify ? initial : initial.subarray(-Math.floor(preRollMs * 32)));
      for (const pcm of this.pendingAudio) stream.write(pcm);
      this.pendingAudio = [];
      this.asrReady = undefined;
    })();
    await this.asrReady;
    if (generation !== this.generation) return;
    clearTimeout(this.timeout);
    this.timeout = setTimeout(
      () => {
        if (this.candidate && keepGeneration) this.finishBarge();
        else this.finishListening();
      },
      verify ? 2500 : 12000,
    );
  }
  private finishListening() {
    const text = this.transcript;
    this.asr?.finish();
    if (!text || this.candidate) {
      this.cancel();
      this.setState('IDLE');
      return;
    }
    void this.respond(text);
  }
  private scheduleEndpoint(text: string) {
    clearTimeout(this.endpoint);
    clearTimeout(this.speculationTimer);
    this.decisionAbort?.abort();
    const decision = ++this.decisionEpoch;
    if (this.opts.speculative && !incomplete(text))
      this.speculationTimer = setTimeout(() => this.startSpeculation(text), 200);
    const commit = async () => {
      if (
        decision !== this.decisionEpoch ||
        this.userSpeaking ||
        this.candidate ||
        this.state !== 'LISTENING'
      )
        return;
      if (this.speakerLocked && !this.speakerMatch) {
        this.abortSpeculation();
        this.transcript = '';
        this.committed = '';
        this.emit({ type: 'transcript', text: '', final: false });
        return;
      }
      if (this.followupListening && this.opts.semantic) {
        this.decisionAbort = new AbortController();
        try {
          const directed = await this.opts.semantic.directed(
            text,
            this.history,
            AbortSignal.any([this.decisionAbort.signal, AbortSignal.timeout(1000)]),
          );
          if (decision !== this.decisionEpoch) return;
          if (!directed) {
            this.cancel();
            this.transcript = '';
            this.emit({ type: 'transcript', text: '', final: false });
            this.setState('IDLE');
            return;
          }
        } catch {
          if (decision !== this.decisionEpoch) return;
          this.cancel();
          this.setState('IDLE');
          this.emit({ type: 'notice', message: '追问判断超时，请点按后再说。' });
          return;
        }
      }
      this.followupListening = false;
      void this.respond(this.transcript);
    };
    if (!this.opts.semantic) {
      this.endpoint = setTimeout(() => void commit(), incomplete(text) ? 1500 : 450);
      return;
    }
    this.endpoint = setTimeout(() => {
      this.decisionAbort = new AbortController();
      const started = performance.now();
      void this.opts
        .semantic!.complete(
          text,
          AbortSignal.any([this.decisionAbort.signal, AbortSignal.timeout(700)]),
        )
        .catch(() => !incomplete(text))
        .then((complete) => {
          if (decision !== this.decisionEpoch || this.userSpeaking) return;
          if (complete) void commit();
          else
            this.endpoint = setTimeout(
              () => void commit(),
              Math.max(0, 1500 - 200 - (performance.now() - started)),
            );
        });
    }, 200);
  }
  private prompt(): Message {
    return {
      role: 'system',
      content: `你是超宝，一个友善、简洁的中文语音助手。回答适合朗读，优先在80字以内，避免Markdown。不能假装执行未提供的工具，也不能编造实时信息。当前北京时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}。`,
    };
  }
  private abortSpeculation() {
    this.speculative?.abort.abort();
    this.speculative?.queue.end();
    this.speculative = undefined;
  }
  private startSpeculation(text: string) {
    if (
      this.state !== 'LISTENING' ||
      this.userSpeaking ||
      this.candidate ||
      this.speculative?.text === text ||
      (this.speakerLocked && !this.speakerMatch)
    )
      return;
    this.abortSpeculation();
    const abort = new AbortController(),
      queue = new AsyncQueue<string>();
    this.speculative = { text, abort, queue };
    void (async () => {
      try {
        let size = 0;
        for await (const delta of this.p.llm.chat(
          [this.prompt(), ...this.history, { role: 'user', content: text }],
          abort.signal,
        )) {
          if (abort.signal.aborted) return;
          size += delta.length;
          if (size > 8000) throw new Error('投机回复过长');
          queue.push(delta);
        }
        queue.end();
      } catch (e) {
        queue.end(
          abort.signal.aborted ? undefined : e instanceof Error ? e : new Error('投机请求失败'),
        );
      }
    })();
  }
  private vad(speaking: boolean, target: boolean) {
    this.userSpeaking = speaking;
    if (this.speakerLocked && !speaking) this.speakerMatch = target;
    if (speaking) {
      this.speechAt = performance.now();
      clearTimeout(this.endpoint);
      clearTimeout(this.speculationTimer);
      this.abortSpeculation();
      this.decisionAbort?.abort();
      this.decisionEpoch++;
    }
    if (!speaking && this.state === 'LISTENING' && this.transcript)
      this.scheduleEndpoint(this.transcript);
    if (speaking && target && this.state === 'SPEAKING' && !this.barge && !this.candidate) {
      this.barge = true;
      this.emit({ type: 'duck', active: true });
      void this.listen(false, true).catch((e) => this.fail(e));
      this.duckTimer = setTimeout(() => this.finishBarge(), 700);
    } else if (speaking && target && this.state === 'IDLE' && Date.now() < this.followupUntil) {
      this.followupListening = true;
      this.setState('LISTENING');
      void this.listen(false).catch((e) => this.fail(e));
    }
  }
  private finishBarge() {
    this.recognizerEpoch++;
    this.asr?.close();
    this.asr = undefined;
    this.asrReady = undefined;
    this.barge = false;
    this.candidate = false;
    clearTimeout(this.duckTimer);
    clearTimeout(this.timeout);
    this.emit({ type: 'duck', active: false });
    this.setState(this.state);
  }
  private async respond(text: string) {
    if (!text.trim()) return;
    const speculative = this.speculative?.text === text ? this.speculative : undefined;
    if (speculative) this.speculative = undefined;
    if (this.turnId && this.answer) this.retainHeard();
    this.cancel();
    const generation = this.generation,
      controller = this.abort,
      signal = controller.signal;
    const stopSpeculation = () => {
      speculative?.abort.abort();
      speculative?.queue.end();
    };
    signal.addEventListener('abort', stopSpeculation, { once: true });
    this.followupUntil = 0;
    this.transcript = '';
    this.committed = '';
    this.emit({ type: 'transcript', text, final: true });
    this.history.push({ role: 'user', content: text });
    if (this.history.length > 24) this.history.splice(0, this.history.length - 24);
    this.turnId = randomUUID();
    const turnId = this.turnId;
    this.answer = '';
    this.heardChars = 0;
    this.setState('THINKING');
    const start = performance.now();
    let firstAudio = true;
    const sentences = new AsyncQueue<string>();
    let sentence = '',
      offset = 0;
    const speaking = (async () => {
      for await (const text of sentences) {
        if (generation !== this.generation) return;
        let first = true,
          bytes = 0;
        if (this.p.demo || !this.audio) {
          if (!this.p.demo)
            this.emit({ type: 'notice', message: '语音尚未连接，本次仅显示文字。' });
          this.heardChars += text.length;
          offset += text.length;
          continue;
        }
        for await (const pcm of this.p.tts.synth(text, signal)) {
          signal.throwIfAborted();
          if (first) {
            this.setState('SPEAKING');
            if (firstAudio) {
              this.emit({
                type: 'metrics',
                name: 'firstAudio',
                ms: Math.round(performance.now() - start),
              });
              firstAudio = false;
            }
            this.emit({
              type: 'utterance',
              text,
              turnId,
              offset,
              marks: estimatedMarks(text, text.length * 190),
              durationMs: text.length * 190,
              estimated: true,
            });
            first = false;
          }
          bytes += pcm.length;
          await this.audio.write(pcm, signal);
        }
        if (!bytes) throw new Error('TTS 未返回音频，请检查音色权限。');
        const durationMs = bytes / 48;
        this.emit({
          type: 'alignment',
          turnId,
          offset,
          marks: estimatedMarks(text, durationMs),
          durationMs,
          estimated: true,
        });
        offset += text.length;
      }
      await this.audio?.drain();
    })();
    // Attach a handler immediately so a TTS failure during LLM streaming is not unhandled.
    let speechError: unknown;
    const safeSpeaking = speaking.catch((e) => {
      speechError = e;
      sentences.end();
      controller.abort();
    });
    try {
      for await (const delta of speculative?.queue ??
        this.p.llm.chat([this.prompt(), ...this.history], signal)) {
        signal.throwIfAborted();
        if (generation !== this.generation) return;
        this.answer += delta;
        sentence += delta;
        this.emit({ type: 'delta', text: delta, turnId });
        for (;;) {
          const match = sentence.match(/^([\s\S]*?[。！？；!?\n])/u);
          if (!match && sentence.length < 100) break;
          const part = match?.[1] ?? sentence.slice(0, 100);
          sentence = sentence.slice(part.length);
          if (part.trim()) sentences.push(part);
        }
      }
      if (sentence.trim()) sentences.push(sentence);
      sentences.end();
      await safeSpeaking;
      if (speechError) throw speechError;
      if (generation !== this.generation || signal.aborted) return;
      this.history.push({ role: 'assistant', content: this.answer });
      const answer = this.answer;
      this.answer = '';
      this.turnId = undefined;
      this.emit({ type: 'done', turnId, text: answer });
      this.followupUntil = Date.now() + this.opts.followupMs;
      this.setState('IDLE');
      this.timeout = setTimeout(() => {
        this.followupUntil = 0;
        this.setState('IDLE');
      }, this.opts.followupMs);
    } catch (error) {
      sentences.end();
      await safeSpeaking;
      if (generation === this.generation && (speechError || !signal.aborted))
        this.fail(speechError ?? error);
    } finally {
      sentences.end();
      signal.removeEventListener('abort', stopSpeculation);
      stopSpeculation();
    }
  }
  private fail(error: unknown) {
    if (this.disposed) return;
    this.cancel();
    this.retainHeard();
    this.followupUntil = 0;
    this.setState('IDLE');
    this.emit({
      type: 'error',
      message: error instanceof Error ? error.message : '请求失败，请重试。',
    });
  }
  close() {
    this.disposed = true;
    this.cancel();
    this.ring.clear();
  }
}
