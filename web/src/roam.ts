/**
 * 待命时的作息：先眨眼待机，5 秒（刚被拖动放下则 2 秒）没唤醒就开始来回走动，
 * 走到一处歇一会儿再走；从待命起超过 1 分钟没唤醒就睡觉。纯函数便于测试。
 */
export type Rest = 'idle' | 'walk' | 'sleep' | 'peek_left' | 'peek_bottom';
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

/**
 * 趴窗口边：手动拖到活动区某条边上松手，就趴在那条边上（左右用 peek_left，右边镜像；上下用 peek_bottom，
 * 上边上下翻转），一直保持，直到被唤醒才出来；出来之后不会自己再进去。
 */
export type Dock = 'left' | 'right' | 'top' | 'bottom';
/** 形象框离边多近（像素）算拖到了边上 */
export const dockGap = 12;
/** 松手时离哪条边足够近就趴哪条边：最近的优先，同样近时 下 > 左 > 右 > 上。 */
export function dockEdge(
  p: { x: number; y: number },
  max: { x: number; y: number },
  gap = dockGap,
) {
  const edges: [Dock, number][] = [
    ['bottom', max.y - p.y],
    ['left', p.x],
    ['right', max.x - p.x],
    ['top', p.y],
  ];
  let best: [Dock, number] | undefined;
  for (const e of edges) if (e[1] <= gap && (!best || e[1] < best[1])) best = e;
  return best?.[0];
}
/** 趴边动作：左右边用 peek_left，上下边用 peek_bottom。 */
export const dockAnimation = (d: Dock) =>
  d === 'left' || d === 'right' ? ('peek_left' as const) : ('peek_bottom' as const);
/**
 * 骨架原点（脚底中心，探头动画里就是窗口边缘那条线）在形象框里的位置：横向比例、离框底的比例。
 * 由 SpineAvatar 的视口（x -330、y -20、620 × 760，四周各留 2%）算出，形象框与视口同宽高比。
 */
export const originX = (330 + 620 * 0.02) / (620 * 1.04);
export const originY = (20 + 760 * 0.02) / (760 * 1.04);
/**
 * 趴边时形象框左上角的位置：让骨架原点正好落在活动区那条边上，沿边方向保持原位置。
 * size 为形象框尺寸，area 为活动区尺寸；右边镜像、上边翻转后原点在框里的位置也跟着翻。
 */
export function dockPos(
  d: Dock,
  p: { x: number; y: number },
  size: { w: number; h: number },
  area: { w: number; h: number },
) {
  if (d === 'left') return { x: -originX * size.w, y: p.y };
  if (d === 'right') return { x: area.w - (1 - originX) * size.w, y: p.y };
  if (d === 'bottom') return { x: p.x, y: area.h - (1 - originY) * size.h };
  return { x: p.x, y: -originY * size.h };
}
