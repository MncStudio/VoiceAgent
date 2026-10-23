import { describe, expect, it } from 'vitest';
import { stateAnimation } from '../web/src/spineAnimation';
describe('Spine 形象动画', () => {
  it('唤醒前睡觉，唤醒后待机，说话时摇尾巴', () => {
    expect(stateAnimation('IDLE')).toBe('sleep');
    for (const s of ['CANDIDATE', 'LISTENING', 'THINKING', 'INTERRUPT'] as const)
      expect(stateAnimation(s)).toBe('idle');
    expect(stateAnimation('SPEAKING')).toBe('tail_wag');
  });
});
