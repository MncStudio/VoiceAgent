import type { Message } from '../../shared/protocol.js';
export type Transcript = { text: string; final: boolean };
export interface ASRStream {
  write(pcm: Buffer): void;
  finish(): void;
  close(): void;
}
/**
 * 结果约定：text 为“当前句”的累计文本（不是增量片段）；final=true 表示该句结束，
 * 下一条结果属于新句。各 Provider 负责把服务原生协议归一到这个约定。
 */
export interface ASRProvider {
  open(
    onResult: (value: Transcript) => void,
    onError: (error: Error) => void,
    signal: AbortSignal,
  ): Promise<ASRStream>;
  /** 提前建立网络连接，隐藏握手延迟；可选。 */
  warm?(): void;
  close?(): void;
}
export interface LLMProvider {
  chat(messages: Message[], signal: AbortSignal): AsyncIterable<string>;
}
export interface TTSProvider {
  synth(text: string, signal: AbortSignal): AsyncIterable<Buffer>;
  warm?(): void;
  close?(): void;
}
export type Providers = { asr: ASRProvider; llm: LLMProvider; tts: TTSProvider; demo: boolean };
