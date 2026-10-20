/**
 * 超宝 SDK：把唤醒、VAD、声纹、LiveKit 音频和对话协议封装成与框架无关的类，
 * 宿主页面（Vue / React / 原生）只负责界面，用事件驱动形象、字幕和按钮。
 */
import type { AssistantState, ServerEvent } from '../../shared/protocol';
import type { AudioStatus } from './audio';
import { AssistantClient, type AppConfig } from './client';
import { serviceUrl, setServiceBase } from './endpoint';

export type { AssistantState, ServerEvent, AudioStatus, AppConfig };
export type ChaobaoConnection = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed';
export type ChaobaoMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** 回答被打断时只保留用户实际听到的部分。 */
  interrupted?: boolean;
};
export type ChaobaoOptions = {
  /** 业务问答由宿主处理，通过 question 事件和 appendAnswer 回传正文。 */
  external?: boolean;
  /** 超宝服务地址，如 https://chaobao.example.com 或 /chaobao；缺省为当前页面同源。 */
  baseUrl?: string;
  /** 断线后自动重连（默认 true）。 */
  reconnect?: boolean;
  /**
   * 记住麦克风开关：上次开着麦克风时，页面加载后在用户第一次点击 / 按键时自动恢复语音
   * （浏览器要求用户手势后才能播放声音）。默认 false。
   */
  rememberVoice?: boolean;
};
export type ChaobaoEventMap = {
  question: { turnId: string; text: string };
  /** 助手状态：IDLE 待命 / CANDIDATE 疑似唤醒 / LISTENING 聆听 / THINKING 思考 / SPEAKING 回答 / INTERRUPT 打断。 */
  state: { state: AssistantState; followupUntil?: number };
  /** 用户语音的实时转写；final=true 时这句话已结束（同时会进入 messages）。 */
  transcript: { text: string; final: boolean };
  /** 对话记录有变化（整份快照，可直接赋给响应式变量）。 */
  messages: ChaobaoMessage[];
  /** 正在生成的回答增量文字。 */
  delta: { turnId: string; text: string };
  /** 一轮回答结束。 */
  done: { turnId: string; text: string };
  /** 正在播报的音量 0~1，可驱动数字人口型。 */
  level: number;
  /** 端侧模型状态与麦克风音量（level 0~1）。 */
  audio: AudioStatus;
  connection: ChaobaoConnection;
  /** 麦克风（语音）是否开启。 */
  voice: boolean;
  /** 唤醒已确认（chime=true 时 SDK 已播放提示音）。 */
  wake: { chime: boolean };
  notice: string;
  error: string;
  /** 首音频等耗时指标（毫秒）。 */
  metrics: { name: string; ms: number };
  /** 服务端原始事件，需要更底层的信息时使用。 */
  event: ServerEvent;
};
type Handler<K extends keyof ChaobaoEventMap> = (payload: ChaobaoEventMap[K]) => void;
const voiceKey = 'chaobao.voice';
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class ChaobaoAssistant {
  config?: AppConfig;
  state: AssistantState = 'IDLE';
  connection: ChaobaoConnection = 'idle';
  voice = false;
  messages: ChaobaoMessage[] = [];
  /** 当前正在说的话（实时转写）。 */
  partial = '';
  private client?: AssistantClient;
  private handlers = new Map<keyof ChaobaoEventMap, Set<(payload: never) => void>>();
  private activeAnswer?: string;
  private hostPending?: { turnId: string; text: string; done: boolean };
  /** 清空对话后，仍在路上的旧回答增量不能把消息“复活”。 */
  private discarded = new Set<string>();
  private recovering = false;
  private destroyed = false;
  private pending?: Promise<AssistantClient>;
  private resumeVoice?: () => void;
  private options: Required<ChaobaoOptions>;
  constructor(options: ChaobaoOptions = {}) {
    this.options = {
      baseUrl: '',
      reconnect: true,
      rememberVoice: false,
      external: false,
      ...options,
    };
    setServiceBase(this.options.baseUrl);
    if (this.options.rememberVoice && localStorage.getItem(voiceKey) === '1') {
      this.resumeVoice = () => {
        this.clearResume();
        if (!this.voice && !this.destroyed) void this.enableVoice().catch(() => {});
      };
      addEventListener('pointerdown', this.resumeVoice, true);
      addEventListener('keydown', this.resumeVoice, true);
    }
  }
  on<K extends keyof ChaobaoEventMap>(name: K, handler: Handler<K>) {
    let set = this.handlers.get(name);
    if (!set) this.handlers.set(name, (set = new Set()));
    set.add(handler as (payload: never) => void);
    return () => this.off(name, handler);
  }
  off<K extends keyof ChaobaoEventMap>(name: K, handler: Handler<K>) {
    this.handlers.get(name)?.delete(handler as (payload: never) => void);
  }
  private emit<K extends keyof ChaobaoEventMap>(name: K, payload: ChaobaoEventMap[K]) {
    this.handlers.get(name)?.forEach((fn) => {
      try {
        (fn as Handler<K>)(payload);
      } catch (error) {
        console.error('[chaobao] 事件处理出错', error);
      }
    });
  }
  private setConnection(value: ChaobaoConnection) {
    if (this.connection === value) return;
    this.connection = value;
    this.emit('connection', value);
  }
  private setVoice(value: boolean) {
    if (this.voice === value) return;
    this.voice = value;
    if (this.options.rememberVoice) localStorage.setItem(voiceKey, value ? '1' : '0');
    this.emit('voice', value);
  }
  private setMessages(next: ChaobaoMessage[]) {
    this.messages = next;
    this.emit('messages', next);
  }
  private fail(error: unknown) {
    const text = message(error);
    this.emit('error', text);
    return text;
  }
  /** 读取服务端配置（唤醒词、模型、端侧资源是否就绪等）。 */
  async init() {
    if (this.config) return this.config;
    const response = await fetch(serviceUrl('/api/config'));
    if (!response.ok) throw new Error(`无法连接超宝服务（HTTP ${response.status}）`);
    this.config = (await response.json()) as AppConfig;
    return this.config;
  }
  private onEvent = (e: ServerEvent) => {
    this.emit('event', e);
    if (e.type === 'question') this.emit('question', { turnId: e.turnId, text: e.text });
    if (e.type === 'state') {
      this.state = e.state;
      this.emit('state', { state: e.state, followupUntil: e.followupUntil });
    }
    if (e.type === 'transcript') {
      this.partial = e.final ? '' : e.text;
      this.emit('transcript', { text: e.text, final: e.final });
      if (e.final)
        this.setMessages([
          ...this.messages,
          { id: crypto.randomUUID(), role: 'user', text: e.text },
        ]);
    }
    if (e.type === 'delta') {
      if (this.discarded.has(e.turnId)) return;
      this.activeAnswer = e.turnId;
      this.partial = '';
      const found = this.messages.some((m) => m.id === e.turnId);
      this.setMessages(
        found
          ? this.messages.map((m) => (m.id === e.turnId ? { ...m, text: m.text + e.text } : m))
          : [...this.messages, { id: e.turnId, role: 'assistant', text: e.text }],
      );
      this.emit('delta', { turnId: e.turnId, text: e.text });
    }
    if (e.type === 'done' && !this.discarded.has(e.turnId))
      this.emit('done', { turnId: e.turnId, text: e.text });
    if (e.type === 'interrupted' && e.turnId)
      this.setMessages(
        this.messages.map((m) =>
          m.id === e.turnId ? { ...m, text: m.text.slice(0, e.heardChars), interrupted: true } : m,
        ),
      );
    if (e.type === 'wake-confirmed') this.emit('wake', { chime: e.chime });
    if (e.type === 'metrics') this.emit('metrics', { name: e.name, ms: e.ms });
    if (e.type === 'notice') this.emit('notice', e.message);
    if (e.type === 'error') this.emit('error', e.message);
  };
  private create() {
    return new AssistantClient(
      this.onEvent,
      (s) => this.emit('audio', s),
      (level) => this.emit('level', level),
      () => void this.recover(),
      this.options.external,
    );
  }
  /** 建立对话会话（文字即可用）；重复调用会复用已有连接。 */
  async connect() {
    if (this.destroyed) throw new Error('助手已销毁');
    if (this.client && this.connection === 'connected') return this.client;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      this.setConnection('connecting');
      await this.init();
      const next = this.create();
      try {
        await next.connect();
      } catch (error) {
        await next.close().catch(() => {});
        this.setConnection('idle');
        throw error;
      }
      this.client = next;
      this.setConnection('connected');
      return next;
    })().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  /** 开启麦克风与语音播报。需在用户点击等手势中调用，否则浏览器会阻止播放。 */
  async enableVoice() {
    this.clearResume();
    if (this.voice) return;
    try {
      const config = await this.init();
      if (config.provider === 'demo') throw new Error('超宝服务处于演示模式，只支持文字。');
      const client = await this.connect();
      await client.enableVoice(config);
      this.setVoice(true);
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }
  /** 关闭麦克风（同时结束当前会话，下次说话或输入时重新建立）。 */
  async disableVoice() {
    this.clearResume();
    const old = this.client;
    this.client = undefined;
    this.setVoice(false);
    this.setConnection('idle');
    this.state = 'IDLE';
    this.emit('state', { state: 'IDLE' });
    await old?.close().catch(() => {});
  }
  async toggleVoice() {
    if (this.voice) await this.disableVoice();
    else await this.enableVoice();
  }
  /** 点按唤醒：免唤醒词直接进入聆听。 */
  async wake() {
    try {
      (await this.connect()).send({ type: 'wake', source: 'button' });
    } catch (error) {
      this.fail(error);
    }
  }
  /** 文字提问（打断当前回答）。 */
  async sendText(text: string) {
    if (!text.trim()) return;
    try {
      (await this.connect()).send({ type: 'text', text: text.trim() });
    } catch (error) {
      this.fail(error);
    }
  }
  /** 按顺序回传纯文本正文；最后一包传 done=true。失效轮次由服务端丢弃。 */
  appendAnswer(turnId: string, text: string, done = false) {
    if (this.destroyed) return;
    if (this.hostPending?.turnId === turnId) {
      this.hostPending.text += text;
      this.hostPending.done ||= done;
      return;
    }
    const batch = { turnId, text, done };
    this.hostPending = batch;
    queueMicrotask(() => {
      if (this.destroyed || this.hostPending !== batch) return;
      this.hostPending = undefined;
      for (let at = 0; at < batch.text.length; at += 2000)
        this.client?.send({ type: 'host-answer', turnId, text: batch.text.slice(at, at + 2000) });
      if (batch.done) this.client?.send({ type: 'host-answer', turnId, text: '', done: true });
    });
  }

  /** 停止当前回答。 */
  stop() {
    this.hostPending = undefined;
    this.client?.send({ type: 'interrupt', reason: 'stop' });
  }
  /** 清空对话上下文与记录。 */
  reset() {
    this.hostPending = undefined;
    if (this.activeAnswer) this.discarded.add(this.activeAnswer);
    this.client?.send({ type: 'reset' });
    this.partial = '';
    this.setMessages([]);
  }
  private async recover() {
    if (this.recovering || this.destroyed) return;
    const old = this.client;
    this.client = undefined;
    this.state = 'IDLE';
    this.emit('state', { state: 'IDLE' });
    await old?.close().catch(() => {});
    if (!this.options.reconnect) {
      this.setVoice(false);
      this.setConnection('idle');
      this.emit('error', '连接已断开。');
      return;
    }
    this.recovering = true;
    this.setConnection('reconnecting');
    this.emit('notice', '连接中断，正在自动重连…');
    for (let attempt = 0; !this.destroyed; attempt++) {
      await new Promise((r) => setTimeout(r, Math.min(15000, 1000 * 2 ** attempt)));
      if (this.destroyed) break;
      const next = this.create();
      try {
        await next.connect();
        if (this.voice && this.config) await next.enableVoice(this.config);
        this.client = next;
        this.setConnection('connected');
        this.emit('notice', '已重新连接。');
        break;
      } catch {
        await next.close().catch(() => {});
      }
    }
    this.recovering = false;
  }
  private clearResume() {
    if (!this.resumeVoice) return;
    removeEventListener('pointerdown', this.resumeVoice, true);
    removeEventListener('keydown', this.resumeVoice, true);
    this.resumeVoice = undefined;
  }
  /** 断开并释放麦克风、模型与连接。组件卸载时调用。 */
  async destroy() {
    this.destroyed = true;
    this.hostPending = undefined;
    this.clearResume();
    const old = this.client;
    this.client = undefined;
    this.setConnection('closed');
    await old?.close().catch(() => {});
    this.handlers.clear();
  }
}
export default ChaobaoAssistant;
