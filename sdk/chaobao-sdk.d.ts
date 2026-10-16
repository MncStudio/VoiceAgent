/**
 * 超宝 SDK 类型声明。运行时由超宝服务提供：`${baseUrl}/sdk/chaobao-sdk.js`。
 * 用法见 README「在其他项目中接入（SDK）」。
 */
export type AssistantState =
  'IDLE' | 'CANDIDATE' | 'LISTENING' | 'THINKING' | 'SPEAKING' | 'INTERRUPT';
export type ChaobaoConnection = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed';
export type ChaobaoMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  interrupted?: boolean;
};
export type AudioStatus = {
  kws: string;
  vad: string;
  noise: string;
  speaker: string;
  /** 麦克风音量 0~1 */
  level: number;
};
export type AppConfig = {
  provider: 'demo' | 'dashscope' | 'local';
  qaProvider: 'demo' | 'openai' | 'yuxi';
  wakeWord: string;
  followupMs: number;
  wakeAck?: string;
  configured: boolean;
  llmModel: string;
  asrModel: string;
  ttsModel: string;
  turnModel: string;
  speculative: boolean;
  speakerThreshold?: number;
  kws?: { threshold: number; boost: number; denoise: boolean };
  assets: { kws: boolean; vad: boolean; speaker: boolean };
};
export type ServerEvent = { type: string; [key: string]: unknown };
export type ChaobaoOptions = {
  /** 超宝服务地址，如 https://chaobao.example.com 或 /chaobao；缺省为当前页面同源。 */
  baseUrl?: string;
  /** 断线自动重连，默认 true。 */
  reconnect?: boolean;
  /** 记住麦克风开关，下次在用户首次点击 / 按键时自动恢复语音，默认 false。 */
  rememberVoice?: boolean;
};
export type ChaobaoEventMap = {
  state: { state: AssistantState; followupUntil?: number };
  transcript: { text: string; final: boolean };
  messages: ChaobaoMessage[];
  delta: { turnId: string; text: string };
  done: { turnId: string; text: string };
  /** 播报音量 0~1，驱动口型 */
  level: number;
  audio: AudioStatus;
  connection: ChaobaoConnection;
  voice: boolean;
  wake: { chime: boolean };
  notice: string;
  error: string;
  metrics: { name: string; ms: number };
  event: ServerEvent;
};
export declare class ChaobaoAssistant {
  constructor(options?: ChaobaoOptions);
  config?: AppConfig;
  state: AssistantState;
  connection: ChaobaoConnection;
  voice: boolean;
  messages: ChaobaoMessage[];
  partial: string;
  on<K extends keyof ChaobaoEventMap>(
    name: K,
    handler: (payload: ChaobaoEventMap[K]) => void,
  ): () => void;
  off<K extends keyof ChaobaoEventMap>(
    name: K,
    handler: (payload: ChaobaoEventMap[K]) => void,
  ): void;
  /** 读取服务端配置 */
  init(): Promise<AppConfig>;
  /** 建立会话（文字可用） */
  connect(): Promise<unknown>;
  /** 开启麦克风与语音（需在用户手势中调用） */
  enableVoice(): Promise<void>;
  disableVoice(): Promise<void>;
  toggleVoice(): Promise<void>;
  /** 点按唤醒 */
  wake(): Promise<void>;
  sendText(text: string): Promise<void>;
  /** 停止当前回答 */
  stop(): void;
  /** 清空对话 */
  reset(): void;
  destroy(): Promise<void>;
}
export default ChaobaoAssistant;
