// 仅用于类型检查：保证手写的 sdk/chaobao-sdk.d.ts 与实现一致，不会被打包。
import type * as Declared from '../../sdk/chaobao-sdk';
import type { ChaobaoAssistant } from './sdk';
import type { ChaobaoEventMap, ChaobaoOptions } from './sdk';
export const implementation: Declared.ChaobaoAssistant = null as unknown as ChaobaoAssistant;
export const options: Declared.ChaobaoOptions = {} as ChaobaoOptions;
export const events: Omit<Declared.ChaobaoEventMap, 'event'> = {} as Omit<ChaobaoEventMap, 'event'>;
