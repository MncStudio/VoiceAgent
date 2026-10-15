import { randomUUID } from 'node:crypto';
import type { AssistantState, ClientEvent, Message, ServerEvent } from '../shared/protocol.js';
import type { Providers, ASRStream } from './providers/types.js';
import {
  AudioRing,
  estimatedMarks,
  hasWake,
  incomplete,
  isBackchannel,
  isEcho,
  nextSegment,
  stripWake,
} from './audio.js';
import type { SemanticPolicy } from './semantic.js';
import { AsyncQueue, Semaphore } from './providers/queue.js';
export interface AudioOutput {
  write(pcm: Buffer, signal: AbortSignal): Promise<void>;
  drain(): Promise<void>;
  clear(): void;
}
/**
 * 识别通道的用途：
 * - verify：空闲时 KWS 候选，用环形缓冲复核唤醒词；
 * - verify-speaking：播报/思考中 KWS 候选，复核通过后直接沿用这条识别流聆听；
 * - barge：播报中检测到目标说话人，先压低音量再判断是否真的打断；
 * - query：普通聆听（点按唤醒、追问、打断后）。
 */
type ListenMode = 'verify' | 'verify-speaking' | 'barge' | 'query';
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export class Conversation {
  state: AssistantState = 'IDLE';
  readonly ring = new AudioRing();
  readonly history: Message[] = [];
  private generation = 0;
  /** 回答（LLM / TTS）生命周期。 */
  private abort = new AbortController();
  /** 识别生命周期，与回答分开：打断时停止回答但保留正在进行的识别。 */
  private listenAbort = new AbortController();
  private asr?: ASRStream;
  private asrReady?: Promise<void>;
  private pendingAudio: Buffer[] = [];
  private transcript = '';
  private committed = '';
  private lastFinal = false;
  private lastResultAt = 0;
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
  /** 当前这句话说完后的整句声纹结果。 */
  private verdict?: { match: boolean; score?: number; speechMs?: number };
  private noSpeechMs = 6000;
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
      /** 整句声纹低于该分数且时长足够时才判为他人；默认 0.35。 */
      speakerReject?: number;
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
      if (event.final) this.verdict = event;
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
  private closeRecognizer() {
    this.recognizerEpoch++;
    this.listenAbort.abort();
    this.listenAbort = new AbortController();
    this.asr?.close();
    this.asr = undefined;
    this.asrReady = undefined;
    this.pendingAudio = [];
  }
  private cancel() {
    this.generation++;
    this.abort.abort();
    this.abort = new AbortController();
    this.closeRecognizer();
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
  /** 停止当前回答（LLM / TTS / 播放），保留正在进行的识别流。 */
  private stopResponse() {
    const turnId = this.turnId,
      heardChars = this.heardChars;
    this.generation++;
    this.abort.abort();
    this.abort = new AbortController();
    clearTimeout(this.duckTimer);
    clearTimeout(this.timeout);
    this.abortSpeculation();
    this.audio?.clear();
    this.emit({ type: 'duck', active: false });
    this.barge = false;
    this.candidate = false;
    this.retainHeard();
    this.followupUntil = 0;
    this.emit({ type: 'interrupted', turnId, heardChars });
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
  /** 回放起点从 VAD 判定开口前约 400ms 开始，避免截掉句首。 */
  private preRoll(minimum = 700) {
    if (!this.speechAt) return minimum;
    return Math.min(3000, Math.max(minimum, performance.now() - this.speechAt + 400));
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
    // 点按打断时缓冲里多是播报回声，只回放很短的一段。
    void this.listen('query', reason === 'wake' ? 300 : 700).catch((e) => this.fail(e));
  }
  private async wake(source: 'button' | 'kws') {
    if (this.state === 'SPEAKING' || this.state === 'THINKING') {
      if (source === 'button') {
        this.interrupt('wake');
        return;
      }
      // KWS 候选先压低音量，复核失败恢复；不让候选直接污染历史。
      this.emit({ type: 'duck', active: true });
      this.candidate = true;
      if (this.asr || this.asrReady) {
        // 免唤醒打断的识别流已在运行，直接用它复核唤醒词。
        clearTimeout(this.duckTimer);
        this.duckTimer = setTimeout(() => this.finishBarge(), 2500);
        return;
      }
      this.p.asr.warm?.();
      await this.listen('verify-speaking');
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
    await this.listen(source === 'kws' ? 'verify' : 'query');
  }
  private armNoSpeech(ms = this.noSpeechMs) {
    this.noSpeechMs = ms;
    clearTimeout(this.timeout);
    this.timeout = setTimeout(() => this.finishListening(), ms);
  }
  private async listen(mode: ListenMode, preRollMs = 700, noSpeechMs = 6000) {
    if (this.p.demo) return;
    this.closeRecognizer();
    const recognizerEpoch = this.recognizerEpoch,
      signal = this.listenAbort.signal,
      verify = mode === 'verify' || mode === 'verify-speaking';
    this.transcript = '';
    this.committed = '';
    this.lastFinal = false;
    this.lastResultAt = performance.now();
    this.noSpeechMs = noSpeechMs;
    const initial = this.ring.snapshot();
    this.pendingAudio = [];
    const ready = (async () => {
      const stream = await this.p.asr.open(
        (result) => {
          if (recognizerEpoch !== this.recognizerEpoch || signal.aborted) return;
          this.onTranscript(result.text, result.final, mode);
        },
        (error) => {
          if (recognizerEpoch === this.recognizerEpoch) this.fail(error);
        },
        signal,
      );
      if (recognizerEpoch !== this.recognizerEpoch || signal.aborted) {
        stream.close();
        return;
      }
      this.asr = stream;
      const bytes = Math.floor(preRollMs * 16) * 2;
      stream.write(verify ? initial : initial.subarray(Math.max(0, initial.length - bytes)));
      for (const pcm of this.pendingAudio) stream.write(pcm);
      this.pendingAudio = [];
      this.asrReady = undefined;
    })();
    this.asrReady = ready;
    await ready;
    if (recognizerEpoch !== this.recognizerEpoch) return;
    // 超时从识别连接就绪后开始计算，握手时间不再吃掉判断窗口。
    if (mode === 'verify' && this.candidate) {
      clearTimeout(this.timeout);
      this.timeout = setTimeout(() => this.finishListening(), 2500);
    } else if (mode === 'verify-speaking' && this.candidate) {
      clearTimeout(this.duckTimer);
      this.duckTimer = setTimeout(() => this.finishBarge(), 2500);
    } else if (mode === 'barge' && this.barge) {
      clearTimeout(this.duckTimer);
      this.duckTimer = setTimeout(() => this.finishBarge(), 1200);
    } else if (mode === 'query') this.armNoSpeech(noSpeechMs);
  }
  private onTranscript(raw: string, final: boolean, mode: ListenMode) {
    this.lastResultAt = performance.now();
    const speakingNow = this.state === 'SPEAKING' || this.state === 'THINKING';
    if (this.candidate) {
      if (!hasWake(raw, this.opts.wakeWord)) return;
      // 播报内容本身含唤醒词时，残余回声不能算唤醒。
      if (speakingNow && hasWake(this.answer, this.opts.wakeWord) && isEcho(raw, this.answer))
        return;
      this.candidate = false;
      if (speakingNow || mode === 'verify-speaking' || mode === 'barge') this.stopResponse();
      this.barge = false;
      this.setState('LISTENING');
      this.emit({ type: 'wake-confirmed' });
      this.emit({ type: 'notice', message: '我在，请说。' });
      this.armNoSpeech(6000);
    } else if (this.barge) {
      if (isEcho(raw, this.answer)) return;
      if (isBackchannel(raw)) {
        if (final) this.finishBarge();
        return;
      }
      // 确认是真实打断：停止播报，沿用这条识别流继续聆听，不重新建连、不丢句首。
      this.stopResponse();
      this.setState('LISTENING');
      this.armNoSpeech(6000);
    } else if (mode !== 'query' && this.state !== 'LISTENING') return;
    const clean = stripWake(raw, this.opts.wakeWord);
    this.transcript = this.committed + clean;
    this.lastFinal = final;
    if (final) this.committed = this.transcript;
    if (this.state === 'LISTENING') this.armNoSpeech();
    if (this.transcript) {
      this.emit({ type: 'transcript', text: this.transcript, final: false });
      if (!this.userSpeaking) this.scheduleEndpoint(this.transcript);
    }
  }
  /**
   * 已锁定声纹时判断这句话是否放行。只有“足够长且明显不像本人”才拒绝；
   * 短句、边缘分数或声纹未算完一律放行，避免本人追问被误拒。
   */
  private async speakerAccepted() {
    if (!this.speakerLocked || this.speakerMatch) return true;
    const start = performance.now();
    while (!this.verdict && performance.now() - start < 400) await delay(30);
    const v = this.verdict;
    if (!v || v.match) return true;
    return !(
      (v.speechMs ?? 0) >= 1000 &&
      v.score !== undefined &&
      v.score < (this.opts.speakerReject ?? 0.35)
    );
  }
  private lastAnswer() {
    for (let i = this.history.length - 1; i >= 0; i--)
      if (this.history[i].role === 'assistant') return this.history[i].content;
    return '';
  }
  /** 丢弃这句话并回到待机；追问窗口剩余时间保留，本人仍可继续追问。 */
  private dropUtterance() {
    const until = this.followupUntil;
    this.cancel();
    this.closeRecognizer();
    this.transcript = '';
    this.committed = '';
    this.emit({ type: 'transcript', text: '', final: false });
    const left = until - Date.now();
    this.followupUntil = left > 0 ? until : 0;
    if (left > 0)
      this.timeout = setTimeout(() => {
        this.followupUntil = 0;
        this.setState('IDLE');
      }, left);
    this.setState('IDLE');
  }
  private finishListening() {
    // 用户还在说（例如追问开头被短暂静音分隔），不因“无结果”超时结束聆听。
    if (
      !this.candidate &&
      this.userSpeaking &&
      this.state === 'LISTENING' &&
      performance.now() - this.speechAt < 10000
    ) {
      this.armNoSpeech(1000);
      return;
    }
    const text = this.transcript;
    if (!text || this.candidate) {
      this.cancel();
      this.setState('IDLE');
      return;
    }
    void this.respond(text);
  }
  /** 等识别结果稳定：拿到句末 final，或 250ms 内没有新结果，最多等 maxMs。 */
  private async settle(maxMs = 400) {
    const start = performance.now();
    while (
      !this.lastFinal &&
      performance.now() - start < maxMs &&
      performance.now() - this.lastResultAt < 250
    )
      await delay(40);
  }
  private scheduleEndpoint(text: string) {
    clearTimeout(this.endpoint);
    clearTimeout(this.speculationTimer);
    this.decisionAbort?.abort();
    const decision = ++this.decisionEpoch;
    if (this.opts.speculative && !incomplete(text))
      this.speculationTimer = setTimeout(() => this.startSpeculation(text), 120);
    const commit = async () => {
      const stale = () =>
        decision !== this.decisionEpoch ||
        this.userSpeaking ||
        this.candidate ||
        this.state !== 'LISTENING';
      if (stale()) return;
      await this.settle();
      if (stale()) return;
      if (!(await this.speakerAccepted()) || stale()) {
        if (!stale()) this.dropUtterance();
        return;
      }
      if (
        this.followupListening &&
        this.transcript.length >= 4 &&
        isEcho(this.transcript, this.lastAnswer())
      ) {
        // 播报结束后的残余回声被识别成了“追问”。
        this.dropUtterance();
        return;
      }
      if (this.followupListening && this.opts.semantic) {
        this.decisionAbort = new AbortController();
        try {
          const directed = await this.opts.semantic.directed(
            this.transcript,
            this.history,
            AbortSignal.any([this.decisionAbort.signal, AbortSignal.timeout(1000)]),
          );
          if (decision !== this.decisionEpoch) return;
          if (!directed) {
            this.dropUtterance();
            return;
          }
        } catch {
          // 判断超时不拒答：已通过声纹 / VAD 门控的追问默认视为对助手说的。
          if (decision !== this.decisionEpoch) return;
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
          AbortSignal.any([this.decisionAbort.signal, AbortSignal.timeout(600)]),
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
      content: `你是超宝，一个友善、简洁的中文语音助手。回答会被直接朗读：第一句尽量简短（15字以内），整体优先在80字以内，口语化，不用Markdown、列表、表情符号。不能假装执行未提供的工具，也不能编造实时信息。当前北京时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}。`,
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
    this.p.tts.warm?.();
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
    const started = speaking && !this.userSpeaking;
    this.userSpeaking = speaking;
    if (this.speakerLocked && !speaking) this.speakerMatch = target;
    if (started) {
      this.speechAt = performance.now();
      this.verdict = undefined;
      // 用户一开口就预热识别连接；唤醒词说完时握手已完成。
      if (!this.asr && !this.asrReady) this.p.asr.warm?.();
    }
    if (speaking) {
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
      void this.listen('barge', this.preRoll()).catch((e) => this.fail(e));
    } else if (
      speaking &&
      this.state === 'IDLE' &&
      Date.now() < this.followupUntil &&
      !this.followupListening
    ) {
      // 追问窗口内一开口就开始识别，不等声纹（短句根本攒不够声纹片段）；
      // 是否本人在整句说完后用整句声纹判断，明显是他人才丢弃。
      this.followupListening = true;
      clearTimeout(this.timeout); // 窗口到期不能打断正在说的追问
      this.setState('LISTENING');
      void this.listen('query', this.preRoll(), 3000).catch((e) => this.fail(e));
    }
  }
  private finishBarge() {
    this.closeRecognizer();
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
    this.p.tts.warm?.();
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
    // 每句话一拿到就开始合成（最多 2 句并行），播放按顺序进行；
    // 下一句在上一句播放期间已合成好，句间不再出现“建连 + 首包”的空白。
    type Job = { text: string; audio: AsyncQueue<Buffer> };
    const jobs = new AsyncQueue<Job>(),
      slots = new Semaphore(2);
    const synthesize = (text: string) => {
      const audio = new AsyncQueue<Buffer>();
      jobs.push({ text, audio });
      if (this.p.demo || !this.audio) {
        audio.end();
        return;
      }
      void (async () => {
        await slots.acquire();
        try {
          if (signal.aborted) return audio.end();
          for await (const pcm of this.p.tts.synth(text, signal)) audio.push(pcm);
          audio.end();
        } catch (e) {
          audio.end(
            signal.aborted ? undefined : e instanceof Error ? e : new Error('TTS 合成失败。'),
          );
        } finally {
          slots.release();
        }
      })();
    };
    let buffer = '',
      offset = 0,
      firstSegment = true;
    const speaking = (async () => {
      for await (const job of jobs) {
        if (generation !== this.generation) return;
        let first = true,
          bytes = 0;
        if (this.p.demo || !this.audio) {
          if (!this.p.demo)
            this.emit({ type: 'notice', message: '语音尚未连接，本次仅显示文字。' });
          this.heardChars += job.text.length;
          offset += job.text.length;
          continue;
        }
        for await (const pcm of job.audio) {
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
              text: job.text,
              turnId,
              offset,
              marks: estimatedMarks(job.text, job.text.length * 190),
              durationMs: job.text.length * 190,
              estimated: true,
            });
            first = false;
          }
          bytes += pcm.length;
          await this.audio.write(pcm, signal);
        }
        signal.throwIfAborted();
        if (!bytes) throw new Error('TTS 未返回音频，请检查音色权限。');
        const durationMs = bytes / 48;
        this.emit({
          type: 'alignment',
          turnId,
          offset,
          marks: estimatedMarks(job.text, durationMs),
          durationMs,
          estimated: true,
        });
        offset += job.text.length;
      }
      await this.audio?.drain();
    })();
    // Attach a handler immediately so a TTS failure during LLM streaming is not unhandled.
    let speechError: unknown;
    const safeSpeaking = speaking.catch((e) => {
      speechError = e;
      jobs.end();
      controller.abort();
    });
    try {
      for await (const delta of speculative?.queue ??
        this.p.llm.chat([this.prompt(), ...this.history], signal)) {
        signal.throwIfAborted();
        if (generation !== this.generation) return;
        if (firstAudio && !this.answer)
          this.emit({
            type: 'metrics',
            name: 'firstToken',
            ms: Math.round(performance.now() - start),
          });
        this.answer += delta;
        buffer += delta;
        this.emit({ type: 'delta', text: delta, turnId });
        for (;;) {
          const part = nextSegment(buffer, firstSegment);
          if (!part) break;
          buffer = buffer.slice(part.length);
          if (part.trim()) {
            synthesize(part);
            firstSegment = false;
          }
        }
      }
      if (buffer.trim()) synthesize(buffer);
      jobs.end();
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
      jobs.end();
      await safeSpeaking;
      if (generation === this.generation && (speechError || !signal.aborted))
        this.fail(speechError ?? error);
    } finally {
      jobs.end();
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
    this.p.asr.close?.();
    this.p.tts.close?.();
  }
}
