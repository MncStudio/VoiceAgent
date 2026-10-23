import { describe, expect, it } from 'vitest';
import { playsWake, stateAnimation } from '../web/src/spineAnimation';
describe('Spine 形象动画', () => {
  it('唤醒前待唤醒，唤醒后待机，用户说话时聆听，助手说话时说话', () => {
    expect(stateAnimation('IDLE')).toBe('sleep');
    expect(stateAnimation('IDLE', true)).toBe('sleep');
    for (const s of ['CANDIDATE', 'LISTENING', 'THINKING', 'INTERRUPT'] as const)
      expect(stateAnimation(s)).toBe('idle');
    expect(stateAnimation('LISTENING', true)).toBe('listen');
    expect(stateAnimation('THINKING', true)).toBe('idle');
    expect(stateAnimation('SPEAKING')).toBe('speak');
  });
  it('从待唤醒切出时先播唤醒动作', () => {
    expect(playsWake('sleep', 'idle')).toBe(true);
    expect(playsWake('sleep', 'listen')).toBe(true);
    expect(playsWake('idle', 'listen')).toBe(false);
    expect(playsWake('speak', 'sleep')).toBe(false);
  });
});
