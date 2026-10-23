import type { AssistantState } from '../../shared/protocol';
/**
 * 状态 → Spine 循环动画（模型动作：sleep / listen / speak / touch / walk）。
 * - 拖动中（任何状态）：touch
 * - 待命：sleep；待命时在舞台上溜达：walk
 * - 助手说话：speak
 * - 其余唤醒状态（疑似唤醒 / 聆听 / 思考 / 打断），不管用户有没有在说话：listen
 */
export function stateAnimation(state: AssistantState, walking = false, dragging = false) {
  if (dragging) return 'touch';
  if (state === 'IDLE') return walking ? 'walk' : 'sleep';
  if (state === 'SPEAKING') return 'speak';
  return 'listen';
}
/**
 * 点击的摸头动作播放中，循环动画目标变了：回到睡眠时等它播完再接上，
 * 聆听 / 说话 / 走路 / 拖动要立刻切过去。
 */
export function cutsOnce(target: string) {
  return target !== 'sleep';
}
