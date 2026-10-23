/** 待命时在舞台上溜达：睡一会儿 → 走到随机位置 → 再睡。纯函数便于测试。 */
export const walkSpeed = 70; // px / s
export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
/** 打盹时长（毫秒）。 */
export const napMs = (rand = Math.random) => 8000 + rand() * 7000;
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
