import type { AssistantState } from '../../shared/protocol';
/**
 * 状态 → Spine 动画：唤醒前（待机）睡觉，唤醒后待机，说话时摇尾巴。
 * 模型自带的动画：idle / blink / tail_wag / touch / walk / sleep。
 */
export function stateAnimation(state: AssistantState) {
  if (state === 'IDLE') return 'sleep';
  if (state === 'SPEAKING') return 'tail_wag';
  return 'idle';
}
