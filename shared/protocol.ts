import { z } from 'zod';
export const stateNames = [
  'IDLE',
  'CANDIDATE',
  'LISTENING',
  'THINKING',
  'SPEAKING',
  'INTERRUPT',
] as const;
export type AssistantState = (typeof stateNames)[number];
export type Message = { role: 'user' | 'assistant' | 'system'; content: string };
export type CharMark = { char: string; startMs: number; endMs: number; estimated: boolean };
export const clientEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('wake'),
    source: z.enum(['kws', 'button']),
    at: z.number().optional(),
  }),
  z.object({ type: z.literal('text'), text: z.string().trim().min(1).max(2000) }),
  z.object({
    type: z.literal('interrupt'),
    reason: z.enum(['wake', 'stop', 'pause', 'next', 'speech']),
    heardChars: z.number().int().min(0).max(20000).optional(),
  }),
  z.object({ type: z.literal('vad'), speaking: z.boolean(), target: z.boolean() }),
  z.object({
    type: z.literal('speaker'),
    locked: z.boolean(),
    match: z.boolean(),
    /** 整句说完后的最终声纹结果（相似度与有效语音时长），用于追问放行判断。 */
    final: z.boolean().optional(),
    score: z.number().min(-1).max(1).optional(),
    speechMs: z.number().min(0).max(600000).optional(),
  }),
  z.object({
    type: z.literal('playback'),
    turnId: z.string(),
    heardChars: z.number().int().min(0).max(20000),
    done: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('host-answer'),
    turnId: z.string().uuid(),
    text: z.string().max(2000),
    done: z.boolean().optional(),
  }),
  z.object({ type: z.literal('reset') }),
]);
export type ClientEvent = z.infer<typeof clientEventSchema>;
export type ServerEvent =
  | { type: 'state'; state: AssistantState; followupUntil?: number }
  | { type: 'transcript'; text: string; final: boolean }
  | { type: 'question'; text: string; turnId: string }
  | { type: 'delta'; text: string; turnId: string }
  | {
      type: 'utterance';
      text: string;
      turnId: string;
      offset: number;
      marks: CharMark[];
      durationMs: number;
      estimated: boolean;
    }
  | {
      type: 'alignment';
      turnId: string;
      offset: number;
      marks: CharMark[];
      durationMs: number;
      estimated: boolean;
    }
  | { type: 'done'; turnId: string; text: string }
  | { type: 'interrupted'; turnId?: string; heardChars: number }
  | { type: 'duck'; active: boolean }
  | { type: 'error'; message: string }
  | { type: 'notice'; message: string }
  /** chime=true 时由浏览器播放提示音；否则服务端会在需要时播报语音应答。 */
  | { type: 'wake-confirmed'; chime: boolean }
  /** 服务端即将播放唤醒应答（如“我在”），浏览器需恢复播放音量。 */
  | { type: 'ack'; text: string }
  | { type: 'metrics'; name: string; ms: number };
