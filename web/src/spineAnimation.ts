import type { AssistantState } from '../../shared/protocol';
import type { Rest } from './roam';
/**
 * 状态 → Spine 循环动画（模型动作：sleep / idle / blink / listen / speak / touch / walk）。
 * - 拖动中（任何状态）：touch
 * - 没唤醒：按作息 rest——眨眼待机 idle（叠加随机 blink）→ 来回走动 walk → 睡觉 sleep
 * - 助手说话：speak
 * - 其余唤醒状态（疑似唤醒 / 聆听 / 思考 / 打断 / 追问窗口），不管用户有没有在说话：listen
 */
export function stateAnimation(state: AssistantState, rest: Rest = 'sleep', dragging = false) {
  if (dragging) return 'touch';
  if (state === 'IDLE') return rest;
  if (state === 'SPEAKING') return 'speak';
  return 'listen';
}
/**
 * 点击的摸头动作播放中，循环动画目标变了：回到待机 / 睡眠时等它播完再接上，
 * 聆听 / 说话 / 走路 / 拖动要立刻切过去。
 */
export function cutsOnce(target: string) {
  return target !== 'sleep' && target !== 'idle';
}
