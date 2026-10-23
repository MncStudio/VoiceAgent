import type { AssistantState } from '../../shared/protocol';
/**
 * 状态 → Spine 循环动画（模型 v6：sleep / wake / idle / blink / listen / speak / touch / walk）。
 * - 唤醒前（待命）：sleep
 * - 唤醒后、用户还没开口（疑似唤醒 / 等待说话 / 思考 / 打断）：idle，另叠加随机眨眼
 * - 用户正在说话：listen
 * - 助手说话：speak
 * 从 sleep 切到其他动画时先播一次 wake（唤醒动作），播完接上当前状态的动画。
 */
export function stateAnimation(state: AssistantState, hearing = false) {
  if (state === 'IDLE') return 'sleep';
  if (state === 'SPEAKING') return 'speak';
  if (state === 'LISTENING' && hearing) return 'listen';
  return 'idle';
}
/** 这次切换要不要先播唤醒动作。 */
export function playsWake(from: string, to: string) {
  return from === 'sleep' && to !== 'sleep';
}
