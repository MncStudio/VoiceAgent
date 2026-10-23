/**
 * 浏览器自动播放策略：页面还没有用户手势（点击 / 按键）时，AudioContext 会停在 suspended，
 * resume() 也会一直挂起。默认自动连接麦克风时不能卡在这里：最多等一小会儿，
 * 仍未运行就在用户第一次点击 / 按键时再恢复。
 */
export function onUserGesture(fn: () => void) {
  const run = () => {
    off();
    fn();
  };
  const off = () => {
    removeEventListener('pointerdown', run, true);
    removeEventListener('keydown', run, true);
  };
  addEventListener('pointerdown', run, true);
  addEventListener('keydown', run, true);
  return off;
}
/** 不超过 ms 毫秒地等待 promise；超时或失败都只返回，不抛错。 */
export function settle(promise: Promise<unknown>, ms: number) {
  return Promise.race([promise.catch(() => {}), new Promise((r) => setTimeout(r, ms))]);
}
/** 尝试启动音频；返回是否已在运行。未运行时会在下一次用户手势时自动恢复。 */
export async function resumeAudio(context: AudioContext, ms = 400) {
  if (context.state === 'running') return true;
  await settle(context.resume(), ms);
  if ((context.state as string) === 'running') return true;
  onUserGesture(() => {
    if (context.state === 'suspended') void context.resume().catch(() => {});
  });
  return false;
}
