import type { Message } from '../../shared/protocol.js';
export type Transcript = { text: string; final: boolean };
export interface ASRStream {
  write(pcm: Buffer): void;
  finish(): void;
  close(): void;
}
export interface ASRProvider {
  open(
    onResult: (value: Transcript) => void,
    onError: (error: Error) => void,
    signal: AbortSignal,
  ): Promise<ASRStream>;
}
export interface LLMProvider {
  chat(messages: Message[], signal: AbortSignal): AsyncIterable<string>;
}
export interface TTSProvider {
  synth(text: string, signal: AbortSignal): AsyncIterable<Buffer>;
}
export type Providers = { asr: ASRProvider; llm: LLMProvider; tts: TTSProvider; demo: boolean };
