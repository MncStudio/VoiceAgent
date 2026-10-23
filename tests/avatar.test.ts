import { describe, expect, it } from 'vitest';
import { cutsOnce, playsWake, stateAnimation } from '../web/src/spineAnimation';
import { clamp, napMs, pickTarget, step } from '../web/src/roam';
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
  it('待命时走动用 walk，唤醒后不再走', () => {
    expect(stateAnimation('IDLE', false, true)).toBe('walk');
    expect(stateAnimation('LISTENING', false, true)).toBe('idle');
    expect(stateAnimation('SPEAKING', false, true)).toBe('speak');
  });
  it('只有从睡眠醒来进入待机才播唤醒动作，直接聆听 / 说话不播', () => {
    expect(playsWake('sleep', 'idle')).toBe(true);
    expect(playsWake('sleep', 'listen')).toBe(false);
    expect(playsWake('sleep', 'speak')).toBe(false);
    expect(playsWake('sleep', 'walk')).toBe(false);
    expect(playsWake('walk', 'idle')).toBe(false);
    expect(playsWake('idle', 'listen')).toBe(false);
    expect(playsWake('speak', 'sleep')).toBe(false);
  });
  it('唤醒 / 摸头动作中：开口聆听、说话、走路立刻切换，回待机 / 睡眠等播完', () => {
    for (const t of ['listen', 'speak', 'walk']) expect(cutsOnce(t)).toBe(true);
    for (const t of ['idle', 'sleep']) expect(cutsOnce(t)).toBe(false);
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
