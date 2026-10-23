import type { AssistantState } from '../../shared/protocol';
/**
 * 状态 → Spine 循环动画（模型 v6：sleep / wake / idle / blink / listen / speak / touch / walk）。
 * - 唤醒前（待命）：sleep；待命时在舞台上溜达：walk
 * - 唤醒后、用户还没开口（疑似唤醒 / 等待说话 / 思考 / 打断）：idle，另叠加随机眨眼
 * - 用户正在说话：listen
 * - 助手说话：speak
 */
export function stateAnimation(state: AssistantState, hearing = false, walking = false) {
  if (state === 'IDLE') return walking ? 'walk' : 'sleep';
  if (state === 'SPEAKING') return 'speak';
  if (state === 'LISTENING' && hearing) return 'listen';
  return 'idle';
}
/** 这次切换要不要先播唤醒动作：只有从睡眠醒来、进入待机时才播；直接开口聆听 / 说话时不播。 */
export function playsWake(from: string, to: string) {
  return from === 'sleep' && to === 'idle';
}
/**
 * 一次性动作（wake / touch）播放中，循环动画目标变了：
 * 目标是 idle / sleep 时等它播完再接上，聆听 / 说话 / 走路要立刻切过去。
 */
export function cutsOnce(target: string) {
  return target !== 'idle' && target !== 'sleep';
}
