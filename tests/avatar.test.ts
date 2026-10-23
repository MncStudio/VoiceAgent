import { describe, expect, it } from 'vitest';
import { cutsOnce, stateAnimation } from '../web/src/spineAnimation';
import { clamp, napMs, pickTarget, step } from '../web/src/roam';
describe('Spine 形象动画', () => {
  it('待命睡眠 / 走动，唤醒后不管有没有人说话都用聆听，助手说话时说话', () => {
    expect(stateAnimation('IDLE')).toBe('sleep');
    expect(stateAnimation('IDLE', true)).toBe('walk');
    for (const s of ['CANDIDATE', 'LISTENING', 'THINKING', 'INTERRUPT'] as const)
      expect(stateAnimation(s)).toBe('listen');
    expect(stateAnimation('LISTENING', true)).toBe('listen');
    expect(stateAnimation('SPEAKING')).toBe('speak');
  });
  it('任何状态拖动中都用摸头动作', () => {
    for (const s of [
      'IDLE',
      'CANDIDATE',
      'LISTENING',
      'THINKING',
      'SPEAKING',
      'INTERRUPT',
    ] as const)
      expect(stateAnimation(s, true, true)).toBe('touch');
  });
  it('点击动作中：回睡眠等播完，其余立刻切换', () => {
    for (const t of ['listen', 'speak', 'walk', 'touch']) expect(cutsOnce(t)).toBe(true);
    expect(cutsOnce('sleep')).toBe(false);
  });
});
describe('形象走动', () => {
  it('打盹 8–15 秒', () => {
    expect(napMs(() => 0)).toBe(8000);
    expect(napMs(() => 1)).toBe(15000);
  });
  it('目的地在区域内且离当前位置足够远', () => {
    for (let i = 0; i < 50; i++) {
      const t = pickTarget(100, 600);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(600);
      expect(Math.abs(t - 100)).toBeGreaterThanOrEqual(140);
    }
    // 随机数总落在附近：退化为走到另一头
    expect(pickTarget(100, 600, () => 0.2)).toBe(600);
    expect(pickTarget(500, 600, () => 0.8)).toBe(0);
    // 区域太窄不走
    expect(pickTarget(10, 20)).toBe(10);
  });
  it('按速度逐帧逼近目标，不越过', () => {
    expect(step(0, 100, 0.5, 70)).toBe(35);
    expect(step(100, 0, 0.5, 70)).toBe(65);
    expect(step(90, 100, 0.5, 70)).toBe(100);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
  });
});
