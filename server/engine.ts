import { randomUUID } from 'node:crypto';
import type { AssistantState, ClientEvent, Message, ServerEvent } from '../shared/protocol.js';
import type { Providers, ASRStream } from './providers/types.js';
import {
  AudioRing,
  estimatedMarks,
  hasWake,
  incomplete,
  incompleteLevel,
  isBackchannel,
  isEcho,
  nextSegment,
  stripWake,
  wakeList,
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
/** 唤醒应答音频缓存：同一音色下“我在”只合成一次，之后零延迟播放。 */
const ackCache = new Map<string, Promise<Buffer>>();
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
  private acking?: AbortController;
  /** 应答代次：新的唤醒 / 打断 / 停止会作废尚未播出的应答。 */
  private ackEpoch = 0;
  /** 当前应答播完的时刻；回答的语音排在应答之后播放。 */
  private ackDone?: Promise<void>;
  /** 当前回答这一轮在 history 中的起点（用户问题的位置）。 */
  private turnStart = 0;
  /** 被停止的那一轮的起点：再次唤醒时整轮移出上下文，不再回答之前的问题。 */
  private stoppedTurnStart?: number;
  /** 回答中本地唤醒命中、已停止回答，正在复核唤醒词。 */
  private rewaking = false;
  /** 唤醒复核期间最后一次识别结果，复核失败时写日志，便于判断是哪一级没通过。 */
  private lastVerifyText = '';
  /** 唤醒已在哪条识别流上确认过：同一条流上晚到的 KWS 候选不再重新复核。 */
  private wakeEpoch = -1;
  /** 免唤醒打断停止回答的时刻与识别流：随后识别出唤醒词时按“回答中再次唤醒”处理。 */
  private bargeStop = { epoch: -1, at: 0 };
  /** 本地唤醒在哪条识别流期间命中过：命中过才允许宽松匹配（容忍一个音节听错）。 */
  private kwsEpoch = -1;
  /** 当前识别流最近一次原始识别结果。 */
  private lastRaw = '';
  /** 刚播过的应答文本，识别结果开头若是它的回声需去掉。 */
  private ackEcho = '';
  /** 当前这句话说完后的整句声纹结果。 */
  private verdict?: { match: boolean; score?: number; speechMs?: number };
  private noSpeechMs = 6000;
  private decisionEpoch = 0;
  private decisionAbort?: AbortController;
  private hostAnswer?: { turnId: string; queue: AsyncQueue<string>; size: number };
  private speculative?: { text: string; queue: AsyncQueue<string>; abort: AbortController };
  private speculationTimer?: ReturnType<typeof setTimeout>;
  /**
   * 未唤醒旁听：待机（以及 WAKE_REQUIRED 下回答中）有人开口但端侧唤醒没命中时，
   * 单独开一条识别流听这句话，说完只写日志“听成了什么”，不触发任何对话。
   */
  private probe?: {
    stream?: ASRStream;
    pending: Buffer[];
    abort: AbortController;
    committed: string;
    partial: string;
    state: AssistantState;
    done?: ReturnType<typeof setTimeout>;
    limit: ReturnType<typeof setTimeout>;
  };
  constructor(
    private p: Providers,
    private emit: (e: ServerEvent) => void,
    private opts: {
      /** 唤醒词，可用逗号分隔多个（如“你好小圆,你好小月”）。 */
      wakeWord: string;
      /** 唤醒词常被识别成的近音写法（如“你好小严”），复核时也算唤醒。 */
      wakeAliases?: string[];
      /** 只说唤醒词时播报的短应答（随机选一条）；为空时只播提示音。 */
      wakeAck?: string[];
      /** 回答过程中再次唤醒时的短应答；为空时沿用 wakeAck。 */
      rewakeAck?: string[];
      followupMs: number;
      /** 每次提问都要先唤醒：关闭回答后的免唤醒追问，以及回答中本人开口即打断。 */
      wakeRequired?: boolean;
      /** 句子明显没说完（“帮我查询”）时，停顿多久才当作说完；默认 3000ms。 */
      incompleteMs?: number;
      semantic?: SemanticPolicy;
      speculative?: boolean;
      /** 宿主负责业务问答，只把正文增量交给语音队列。 */
      external?: boolean;
      /** 整句声纹低于该分数且时长足够时才判为他人；默认 0.35。 */
      speakerReject?: number;
      /** 没唤醒时也识别开口的内容并写日志（排查唤醒词没喊醒 / 听错），不影响对话；默认关闭。 */
      missLog?: boolean;
    },
    private audio?: AudioOutput,
  ) {
    this.wakeWords = wakeList([...wakeList(opts.wakeWord), ...wakeList(opts.wakeAliases)]);
  }
  /** 复核时认可的全部写法：唤醒词（可多个）+ 近音写法（WAKE_WORD_ALIASES）。 */
  private wakeWords: string[];
  attachAudio(audio: AudioOutput) {
    this.audio = audio;
    // 语音一接通就预合成应答，第一次唤醒也不用等 TTS。
    for (const text of [...(this.opts.wakeAck ?? []), ...(this.opts.rewakeAck ?? [])])
      void this.ackAudio(text).catch(() => {});
  }
  private ackAudio(text: string) {
    let cached = ackCache.get(text);
    if (!cached) {
      cached = (async () => {
        const chunks: Buffer[] = [];
        for await (const pcm of this.p.tts.synth(text, AbortSignal.timeout(5000))) chunks.push(pcm);
        return Buffer.concat(chunks);
      })();
      cached.catch(() => ackCache.delete(text));
      ackCache.set(text, cached);
    }
    return cached;
  }
  private acks(rewake: boolean) {
    return (rewake && this.opts.rewakeAck?.length ? this.opts.rewakeAck : this.opts.wakeAck) ?? [];
  }
  /**
   * 每次唤醒都先应一声（“我在”）。用户还在说（一句话直达）时等这句说完再应答，
   * 不盖住用户的话；应答不因用户开口而中断，回答的语音排在应答之后播放。
   */
  private acknowledge(texts: string[]) {
    if (!texts.length || this.p.demo || !this.audio) return;
    this.stopAck();
    const epoch = ++this.ackEpoch,
      audio = this.audio;
    const live = () => epoch === this.ackEpoch && !this.disposed;
    const done = (async () => {
      // 等用户安静 250ms 再应答（给“唤醒词 + 短停顿 + 命令”留接话时间）；最多等 10 秒。
      const start = performance.now();
      let quietSince = performance.now();
      while (live() && performance.now() - start < 10000) {
        if (this.userSpeaking) quietSince = performance.now();
        else if (performance.now() - quietSince >= 250) break;
        await delay(30);
      }
      if (!live()) return;
      const text = texts[Math.floor(Math.random() * texts.length)];
      let pcm: Buffer;
      try {
        pcm = await Promise.race([
          this.ackAudio(text),
          delay(1500).then(() => Promise.reject(new Error('应答合成超时'))),
        ]);
      } catch {
        return;
      }
      if (!live() || !pcm.length) return;
      const controller = new AbortController();
      this.acking = controller;
      this.ackEcho = text;
      this.emit({ type: 'ack', text });
      try {
        await audio.write(pcm, controller.signal);
        await audio.drain();
      } catch {
        // 新的唤醒 / 打断停止了应答
      } finally {
        if (this.acking === controller) this.acking = undefined;
      }
      // 应答期间没人说话，从应答结束起重新计“无语音”超时。
      if (live() && this.state === 'LISTENING' && !this.transcript && !this.userSpeaking)
        this.armNoSpeech(6000);
    })();
    this.ackDone = done;
  }
  private stopAck() {
    this.ackEpoch++;
    this.ackDone = undefined;
    if (!this.acking) return;
    this.acking.abort();
    this.acking = undefined;
    this.audio?.clear();
  }
  private setState(state: AssistantState) {
    // 状态变化（唤醒、开始回答、回答结束）时旁听作废：这句话已经有了去处。
    if (this.probe && state !== this.probe.state) this.closeProbe();
    this.state = state;
    this.emit({ type: 'state', state, followupUntil: this.followupUntil });
  }
  handle(event: ClientEvent) {
    if (event.type === 'host-answer') {
      const host = this.hostAnswer;
      if (!host || event.turnId !== host.turnId) return;
      host.size += event.text.length;
      if (host.size > 20000) {
        this.fail(new Error('朗读内容超过 20000 字。'));
        return;
      }
      if (event.text) host.queue.push(event.text);
      if (event.done) {
        clearTimeout(this.timeout);
        host.queue.end();
      }
      return;
    }
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
    if (this.probe) {
      if (this.probe.stream) this.probe.stream.write(pcm);
      else if (this.probe.pending.length < 150) this.probe.pending.push(Buffer.from(pcm));
    }
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
  /** keepAck：开始回答时保留正在播放的唤醒应答，回答排在它之后。 */
  private cancel(keepAck = false) {
    this.hostAnswer?.queue.end();
    this.hostAnswer = undefined;
    if (!keepAck) this.stopAck();
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
    if (!keepAck || !this.acking) this.audio?.clear();
    this.emit({ type: 'duck', active: false });
    this.candidate = false;
    this.barge = false;
    this.followupListening = false;
  }
  /** 停止当前回答（LLM / TTS / 播放），保留正在进行的识别流。 */
  private stopResponse() {
    const turnId = this.turnId,
      heardChars = this.heardChars;
    if (turnId) this.stoppedTurnStart = this.turnStart;
    this.generation++;
    this.abort.abort();
    this.abort = new AbortController();
    clearTimeout(this.duckTimer);
    clearTimeout(this.timeout);
    this.abortSpeculation();
    this.hostAnswer?.queue.end();
    this.hostAnswer = undefined;
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
      heardChars = this.heardChars,
      turnStart = this.turnStart;
    this.cancel();
    this.retainHeard();
    // 点按唤醒打断：这一轮整轮移出上下文，不再回答之前的问题。
    if (reason === 'wake' && turnId) this.history.splice(turnStart);
    this.stoppedTurnStart = undefined;
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
    if (reason === 'wake') this.acknowledge(this.acks(true));
  }
  private async wake(source: 'button' | 'kws') {
    this.closeProbe();
    if (source === 'kws' && this.state === 'LISTENING' && (this.asr || this.asrReady)) {
      // 这条识别流上已确认过唤醒（识别结果先于本地唤醒到达），不重复复核、不重复应答。
      // 浏览器命中本地唤醒时已先显示“疑似唤醒”，重发当前状态让界面恢复。
      if (this.wakeEpoch === this.recognizerEpoch) return this.setState(this.state);
      // 刚被免唤醒打断停掉回答：唤醒词就在这条识别流里，直接沿用它确认，不重开连接、不丢句首。
      if (this.rewakeOpen()) {
        this.kwsEpoch = this.recognizerEpoch;
        if (hasWake(this.lastRaw, this.wakeWords, true)) this.confirmWake(this.lastRaw, true);
        else this.setState(this.state);
        return;
      }
    }
    if (this.state === 'SPEAKING' || this.state === 'THINKING') {
      if (source === 'button') {
        this.interrupt('wake');
        return;
      }
      // 回答中本地唤醒一命中就立即停止回答，不等复核；复核通过后应答“我在”并聆听，
      // 复核没通过则打开追问窗口，用户可直接说话。
      this.stopResponse();
      this.rewaking = true;
      this.candidate = true;
      this.setState('CANDIDATE');
      if (this.asr || this.asrReady) {
        // 免唤醒打断的识别流已在运行，直接用它复核（唤醒词可能已在识别结果里）。
        clearTimeout(this.timeout);
        this.timeout = setTimeout(() => this.finishListening(), 2500);
        if (this.lastRaw) this.onTranscript(this.lastRaw, false, 'barge');
        return;
      }
      this.p.asr.warm?.();
      await this.listen('verify');
      return;
    }
    if (this.state !== 'CANDIDATE') this.rewaking = false;
    this.cancel();
    this.followupUntil = 0;
    this.candidate = source === 'kws';
    this.setState(this.candidate ? 'CANDIDATE' : 'LISTENING');
    if (this.p.demo) {
      this.setState('LISTENING');
      this.emit({ type: 'notice', message: '演示模式：请在下方输入文字。' });
      return;
    }
    if (source === 'button') this.acknowledge(this.acks(false));
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
    this.lastRaw = '';
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
          if (recognizerEpoch === this.recognizerEpoch && !signal.aborted) this.fail(error);
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
    try {
      await ready;
    } catch (error) {
      // 旧连接的握手失败可能晚于打断 / 下一轮提问，不能再取消当前对话。
      if (recognizerEpoch !== this.recognizerEpoch || signal.aborted) return;
      throw error;
    }
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
      // 思考时没有播报压着，多给一点时间等识别结果。
      this.duckTimer = setTimeout(
        () => this.finishBarge(),
        this.state === 'THINKING' ? 2000 : 1200,
      );
    } else if (mode === 'query') this.armNoSpeech(noSpeechMs);
  }
  private rewakeOpen() {
    return (
      this.bargeStop.epoch === this.recognizerEpoch && performance.now() - this.bargeStop.at < 4000
    );
  }
  /**
   * 唤醒确认。rewake=true 表示回答（思考 / 播报）过程中再次唤醒：立即停止回答，
   * 只说了唤醒词就应答一声（REWAKE_ACK，默认“你好”）等用户提问；唤醒词后直接接了
   * 问题（一句话直达）则不应答，直接听完回答新问题。
   */
  private confirmWake(raw: string, rewake: boolean) {
    rewake ||= this.rewaking;
    this.rewaking = false;
    this.candidate = false;
    this.wakeEpoch = this.recognizerEpoch;
    this.lastVerifyText = '';
    console.info(`[wake] ${rewake ? '回答中再次唤醒' : '复核通过'}：“${raw}”`);
    if (this.state === 'SPEAKING' || this.state === 'THINKING' || this.barge || this.turnId)
      this.stopResponse();
    else {
      clearTimeout(this.duckTimer);
      this.emit({ type: 'duck', active: false });
    }
    // 再次唤醒：被打断的那一轮（问题 + 已播出的半句回答）整轮移出上下文，不再回答之前的问题。
    if (rewake && this.stoppedTurnStart !== undefined) this.history.splice(this.stoppedTurnStart);
    this.stoppedTurnStart = undefined;
    this.barge = false;
    this.followupListening = false;
    this.setState('LISTENING');
    const acks = this.acks(rewake);
    const voiceAck = !!acks.length && !this.p.demo && !!this.audio;
    this.emit({ type: 'wake-confirmed', chime: !voiceAck });
    this.emit({ type: 'notice', message: rewake ? '已停止回答，请说。' : '我在，请说。' });
    // 打断时已显示的半句（多是唤醒词本身）清掉，下面按去掉唤醒词后的内容重新显示。
    this.transcript = '';
    this.committed = '';
    this.emit({ type: 'transcript', text: '', final: false });
    this.armNoSpeech(6000);
    this.ackEcho = '';
    // 每次唤醒都应答；一句话直达时等用户说完再应答，随后回答新问题。
    if (voiceAck) this.acknowledge(acks);
  }
  private onTranscript(raw: string, final: boolean, mode: ListenMode) {
    this.lastResultAt = performance.now();
    this.lastRaw = raw;
    const speakingNow = this.state === 'SPEAKING' || this.state === 'THINKING';
    if (this.candidate) {
      if (!hasWake(raw, this.wakeWords, true)) {
        this.lastVerifyText = raw;
        return;
      }
      // 播报内容本身含唤醒词时，残余回声不能算唤醒。
      if (speakingNow && hasWake(this.answer, this.wakeWords) && isEcho(raw, this.answer)) return;
      this.confirmWake(raw, speakingNow || mode === 'verify-speaking' || mode === 'barge');
    } else if (this.barge) {
      // 播报时过滤播报内容的回声；思考时还没出声，只过滤唤醒应答“我在”的回声。
      if (isEcho(raw, this.state === 'SPEAKING' ? this.answer : '')) return;
      if (this.ackEcho && isEcho(raw, this.ackEcho)) return;
      if (hasWake(raw, this.wakeWords)) this.confirmWake(raw, true);
      else if (isBackchannel(raw)) {
        if (final) this.finishBarge();
        return;
      } else {
        // 思考中（用户还没听到任何回答）本人开口：丢掉刚才的问题，只回答新说的话，
        // 刚才的问题也移出上下文，不会连带回答。
        const pending = this.state === 'THINKING' && !!this.turnId;
        // 确认是真实打断：停止回答，沿用这条识别流继续聆听，不重新建连、不丢句首。
        this.stopResponse();
        if (pending && this.stoppedTurnStart !== undefined) {
          this.history.splice(this.stoppedTurnStart);
          this.stoppedTurnStart = undefined;
        }
        this.bargeStop = { epoch: this.recognizerEpoch, at: performance.now() };
        this.setState('LISTENING');
        this.armNoSpeech(6000);
      }
    } else if (
      this.state === 'LISTENING' &&
      this.wakeEpoch !== this.recognizerEpoch &&
      this.rewakeOpen() &&
      hasWake(raw, this.wakeWords, this.kwsEpoch === this.recognizerEpoch)
    )
      // 打断时先听到“你好…”就停了回答，随后才认出完整唤醒词：同样按再次唤醒处理。
      this.confirmWake(raw, true);
    else if (mode !== 'query' && this.state !== 'LISTENING') return;
    let clean = stripWake(raw, this.wakeWords);
    if (this.ackEcho) {
      // 应答“我在”的残余回声被识别进来时去掉，不当成用户的话。
      const echo = this.ackEcho.replace(/[，。,.!！?？\s]/g, '');
      const head = clean.replace(/^[，。,.!！?？\s]+/, '');
      if (head.startsWith(echo)) clean = head.slice(echo.length).replace(/^[，。,.!！?？\s]+/, '');
    }
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
    if (this.candidate) this.logRejected();
    if (!text || this.candidate) {
      const stopped = this.rewaking && this.candidate;
      this.rewaking = false;
      this.cancel();
      if (stopped && !this.opts.wakeRequired) {
        // 回答已因本地唤醒停止但复核没通过：打开追问窗口，用户可直接说话。
        this.followupUntil = Date.now() + this.opts.followupMs;
        this.timeout = setTimeout(() => {
          this.followupUntil = 0;
          this.setState('IDLE');
        }, this.opts.followupMs);
      }
      this.setState('IDLE');
      return;
    }
    void this.respond(text);
  }
  /**
   * 等这句话的字收齐：流式识别的中间结果常常还差句尾一两个字（“你是谁”先出“你是”），
   * 句尾要等句末 final（ASR 断句静音 + 链路延迟）才补上。VAD 判停时 final 往往还在路上，
   * 所以没拿到 final 就继续等，最多 maxMs；final 一到会重新排期提交（见 scheduleEndpoint）。
   */
  private async settle(maxMs = 900) {
    const start = performance.now();
    while (!this.lastFinal && performance.now() - start < maxMs) await delay(40);
  }
  private scheduleEndpoint(text: string) {
    clearTimeout(this.endpoint);
    clearTimeout(this.speculationTimer);
    this.decisionAbort?.abort();
    const decision = ++this.decisionEpoch;
    if (this.opts.speculative && !this.opts.external && !incomplete(text))
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
    const level = incompleteLevel(text),
      dangling = level === 2,
      pause = dangling ? (this.opts.incompleteMs ?? 3000) : 1500;
    // 没说完时“无语音”超时不能早于断句等待，否则用户想下文时会被提前提交。
    if (dangling && this.state === 'LISTENING') {
      clearTimeout(this.timeout);
      this.timeout = setTimeout(
        () => this.finishListening(),
        Math.max(this.noSpeechMs, pause + 1500),
      );
    }
    if (!this.opts.semantic) {
      // 已拿到句末 final（ASR 已确认静音断句）时字已齐，短等即可提交；否则先等 450ms 看是否继续说。
      // 明显没说完（“帮我查询”）时多等用户想一想，期间一开口就继续听同一句。
      const wait = level ? pause : this.lastFinal ? 200 : 450;
      this.endpoint = setTimeout(() => void commit(), wait);
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
          // 规则已判定没说完时，不因语义模型误判“完整”而抢答。
          if (complete && !dangling) void commit();
          else
            this.endpoint = setTimeout(
              () => void commit(),
              Math.max(0, pause - 200 - (performance.now() - started)),
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
    this.probeVad(speaking);
    if (speaking) {
      clearTimeout(this.endpoint);
      clearTimeout(this.speculationTimer);
      this.abortSpeculation();
      this.decisionAbort?.abort();
      this.decisionEpoch++;
    }
    if (!speaking && this.state === 'LISTENING' && this.transcript)
      this.scheduleEndpoint(this.transcript);
    if (
      speaking &&
      target &&
      !this.opts.wakeRequired &&
      (this.state === 'SPEAKING' || this.state === 'THINKING') &&
      !this.barge &&
      !this.candidate
    ) {
      // 播报 / 思考中本人开口：先识别再判断（唤醒词 → 应答“我在”；附和 → 忽略；其他 → 当作提问）。
      this.barge = true;
      if (this.state === 'SPEAKING') this.emit({ type: 'duck', active: true });
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
  /** 未唤醒旁听：开口时开流（续说沿用同一条），说完 1.5s 内等最终结果再写日志。 */
  private probeVad(speaking: boolean) {
    const probe = this.probe;
    if (probe) {
      clearTimeout(probe.done);
      if (!speaking) probe.done = setTimeout(() => this.closeProbe(true), 1500);
      return;
    }
    if (!speaking || !this.opts.missLog || this.p.demo || this.disposed) return;
    const idle =
      this.state === 'IDLE' && Date.now() >= this.followupUntil && !this.followupListening;
    const answering =
      !!this.opts.wakeRequired &&
      (this.state === 'SPEAKING' || this.state === 'THINKING') &&
      !this.barge &&
      !this.candidate;
    if (!idle && !answering) return;
    if (this.asr || this.asrReady) return;
    const abort = new AbortController();
    const next: NonNullable<Conversation['probe']> = {
      pending: [],
      abort,
      committed: '',
      partial: '',
      state: this.state,
      // 一直有人声（电视、旁人聊天）也最多旁听 15s。
      limit: setTimeout(() => this.probe === next && this.closeProbe(true), 15000),
    };
    this.probe = next;
    const initial = this.ring.snapshot();
    const bytes = Math.floor(this.preRoll() * 16) * 2;
    void this.p.asr
      .open(
        (result) => {
          if (this.probe !== next) return;
          if (result.final) {
            next.committed += result.text;
            next.partial = '';
          } else next.partial = result.text;
        },
        () => {
          if (this.probe === next) this.closeProbe();
        },
        abort.signal,
      )
      .then((stream) => {
        if (this.probe !== next || abort.signal.aborted) return stream.close();
        next.stream = stream;
        stream.write(initial.subarray(Math.max(0, initial.length - bytes)));
        for (const pcm of next.pending) stream.write(pcm);
        next.pending = [];
      })
      .catch(() => {
        if (this.probe === next) this.closeProbe();
      });
  }
  private closeProbe(log = false) {
    const probe = this.probe;
    if (!probe) return;
    this.probe = undefined;
    clearTimeout(probe.done);
    clearTimeout(probe.limit);
    probe.abort.abort();
    probe.stream?.close();
    const text = (probe.committed + probe.partial).trim();
    if (!log || !text) return;
    const answering = probe.state === 'SPEAKING' || probe.state === 'THINKING';
    // 回答中旁听到的多半是播报回声，回声不记。
    if (answering && isEcho(text, this.answer)) return;
    const where = answering ? '回答中' : '待机时';
    const hint = hasWake(text, this.wakeWords)
      ? '，识别结果含唤醒词，端侧唤醒没命中'
      : hasWake(text, this.wakeWords, true)
        ? '，接近唤醒词（差一个音节），端侧唤醒没命中'
        : '';
    console.info(`[wake] ${where}未唤醒，听到：“${text}”${hint}`);
  }
  private logRejected() {
    console.info(
      `[wake] 本地唤醒命中但复核未通过，识别结果：${this.lastVerifyText ? `“${this.lastVerifyText}”` : '（无）'}`,
    );
    this.lastVerifyText = '';
  }
  private finishBarge() {
    if (this.candidate) this.logRejected();
    this.closeRecognizer();
    // timeout 此时可能是宿主问答的 10 分钟兜底，只有唤醒复核才需要清掉。
    if (this.candidate) clearTimeout(this.timeout);
    this.barge = false;
    this.candidate = false;
    clearTimeout(this.duckTimer);
    this.emit({ type: 'duck', active: false });
    this.setState(this.state);
  }
  private async respond(text: string) {
    if (!text.trim()) return;
    const speculative = this.speculative?.text === text ? this.speculative : undefined;
    if (speculative) this.speculative = undefined;
    if (this.turnId && this.answer) this.retainHeard();
    this.cancel(true);
    this.rewaking = false;
    this.stoppedTurnStart = undefined;
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
    this.ackEcho = '';
    this.emit({ type: 'transcript', text, final: true });
    this.history.push({ role: 'user', content: text });
    if (this.history.length > 24) this.history.splice(0, this.history.length - 24);
    this.turnStart = this.history.length - 1;
    this.turnId = randomUUID();
    const turnId = this.turnId;
    this.answer = '';
    this.heardChars = 0;
    this.setState('THINKING');
    const host = this.opts.external
      ? { turnId, queue: new AsyncQueue<string>(), size: 0 }
      : undefined;
    if (host) {
      this.hostAnswer = host;
      // 宿主失联/未完成时不能让会话永久停在 THINKING。
      this.timeout = setTimeout(
        () => this.fail(new Error('业务回答超时，请重新提问。')),
        10 * 60 * 1000,
      );
      this.emit({ type: 'question', turnId, text });
    }
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
    const ack = this.ackDone;
    const speaking = (async () => {
      // 唤醒应答还没播完时，回答排在它之后，不与“我在”交叠。
      if (ack) await ack;
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
            // 思考时本人已开口、正在判断是否打断：开播即压低音量。
            if (this.barge) this.emit({ type: 'duck', active: true });
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
      host?.queue.end();
    });
    try {
      for await (const delta of host?.queue ??
        speculative?.queue ??
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
      clearTimeout(this.timeout);
      this.hostAnswer = undefined;
      this.history.push({ role: 'assistant', content: this.answer });
      const answer = this.answer;
      this.answer = '';
      this.turnId = undefined;
      this.emit({ type: 'done', turnId, text: answer });
      this.ackEcho = '';
      if (this.opts.wakeRequired) {
        // 每次提问都要先唤醒：回答结束直接待命，不开追问窗口。
        this.followupUntil = 0;
        this.setState('IDLE');
        return;
      }
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
    this.closeProbe();
    this.cancel();
    this.ring.clear();
    this.p.asr.close?.();
    this.p.tts.close?.();
  }
}
