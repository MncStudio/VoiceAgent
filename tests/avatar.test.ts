import { describe, expect, it } from 'vitest';
import { cutsOnce, stateAnimation } from '../web/src/spineAnimation';
import {
  clamp,
  pauseMs,
  pickTarget,
  restPhase,
  step,
  walkAfterDragMs,
  walkAfterMs,
} from '../web/src/roam';
describe('Spine 形象动画', () => {
  it('没唤醒按作息待机 / 走动 / 睡觉，唤醒后（含追问）都用聆听，助手说话时说话', () => {
    expect(stateAnimation('IDLE')).toBe('sleep');
    expect(stateAnimation('IDLE', 'idle')).toBe('idle');
    expect(stateAnimation('IDLE', 'walk')).toBe('walk');
    for (const s of ['CANDIDATE', 'LISTENING', 'THINKING', 'INTERRUPT'] as const)
      expect(stateAnimation(s, 'walk')).toBe('listen');
    expect(stateAnimation('SPEAKING', 'idle')).toBe('speak');
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
      expect(stateAnimation(s, 'walk', true)).toBe('touch');
  });
  it('点击动作中：回待机 / 睡眠等播完，其余立刻切换', () => {
    for (const t of ['listen', 'speak', 'walk', 'touch']) expect(cutsOnce(t)).toBe(true);
    for (const t of ['idle', 'sleep']) expect(cutsOnce(t)).toBe(false);
  });
});
describe('形象作息与走动', () => {
  it('眨眼待机 5 秒后走动，1 分钟没唤醒就睡觉；拖动放下后 2 秒就走', () => {
    expect(restPhase(0)).toBe('idle');
    expect(restPhase(walkAfterMs - 1)).toBe('idle');
    expect(restPhase(walkAfterMs)).toBe('roam');
    expect(restPhase(59999)).toBe('roam');
    expect(restPhase(60000)).toBe('sleep');
    expect(restPhase(1999, walkAfterDragMs)).toBe('idle');
    expect(restPhase(2000, walkAfterDragMs)).toBe('roam');
  });
  it('两段走动之间歇 1.5–4 秒', () => {
    expect(pauseMs(() => 0)).toBe(1500);
    expect(pauseMs(() => 1)).toBe(4000);
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
