/**
 * 待命时的作息：先眨眼待机，5 秒（刚被拖动放下则 2 秒）没唤醒就开始来回走动，
 * 走到一处歇一会儿再走；从待命起超过 1 分钟没唤醒就睡觉。纯函数便于测试。
 */
export type Rest = 'idle' | 'walk' | 'sleep';
export const walkAfterMs = 5000;
export const walkAfterDragMs = 2000;
export const sleepAfterMs = 60000;
export const walkSpeed = 70; // px / s
export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
/** 两段走动之间歇脚（眨眼待机）的时长（毫秒）。 */
export const pauseMs = (rand = Math.random) => 1500 + rand() * 2500;
/** 待命 elapsed 毫秒后处于哪个阶段：待机 → 走动（与歇脚交替）→ 睡觉。 */
export function restPhase(elapsed: number, walkAfter = walkAfterMs) {
  if (elapsed >= sleepAfterMs) return 'sleep';
  return elapsed >= walkAfter ? 'roam' : 'idle';
}
/** 下一个目的地：区域内随机，且至少离当前位置 min(140, 一半宽度) 像素；区域太窄就不走。 */
export function pickTarget(x: number, max: number, rand = Math.random) {
  if (max < 40) return x;
  const gap = Math.min(140, max / 2);
  for (let i = 0; i < 8; i++) {
    const t = rand() * max;
    if (Math.abs(t - x) >= gap) return t;
  }
  return x < max / 2 ? max : 0;
}
/** 向目标走一帧，返回新位置。 */
export function step(x: number, target: number, dt: number, speed = walkSpeed) {
  const d = target - x,
    move = speed * dt;
  return Math.abs(d) <= move ? target : x + Math.sign(d) * move;
}
