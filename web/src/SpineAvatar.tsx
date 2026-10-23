import { useEffect, useRef } from 'react';
import { SpinePlayer } from '@esotericsoftware/spine-player';
import type { AssistantState } from '../../shared/protocol';
import { stateAnimation } from './spineAnimation';

const base = '/avatar/cat-tv-robot/';
/** 猫耳电视机器人（Spine 4.3）。加载失败（无 WebGL / 资源缺失）时回调 onError，由外层换回默认形象。 */
export function SpineAvatar({ state, onError }: { state: AssistantState; onError: () => void }) {
  const host = useRef<HTMLDivElement>(null),
    player = useRef<SpinePlayer>(undefined),
    current = useRef(stateAnimation(state)),
    fail = useRef(onError);
  fail.current = onError;
  useEffect(() => {
    if (!host.current) return;
    let disposed = false;
    const p = new SpinePlayer(host.current, {
      skeleton: `${base}cat_tv_robot.json`,
      atlas: `${base}cat_tv_robot.atlas`,
      animation: current.current,
      defaultMix: 0.25,
      alpha: true,
      backgroundColor: '#00000000',
      showControls: false,
      showLoading: false,
      preserveDrawingBuffer: false,
      viewport: {
        x: -330,
        y: -20,
        width: 620,
        height: 760,
        padLeft: '2%',
        padRight: '2%',
        padTop: '2%',
        padBottom: '2%',
        transitionTime: 0,
      },
      success: (sp) => {
        if (disposed) return;
        // 当前状态可能在加载期间变了
        sp.setAnimation(current.current, true);
      },
      error: (_sp, message) => {
        console.warn('[avatar] Spine 形象加载失败：', message);
        if (!disposed) fail.current();
      },
    });
    player.current = p;
    return () => {
      disposed = true;
      player.current = undefined;
      p.dispose();
    };
  }, []);
  useEffect(() => {
    const next = stateAnimation(state);
    if (next === current.current) return;
    current.current = next;
    const state0 = player.current?.animationState;
    if (state0) state0.setAnimation(0, next, true);
  }, [state]);
  /** 点一下：跳起挥手冒爱心，播完回到当前状态的动画。 */
  const touch = () => {
    const s = player.current?.animationState;
    if (!s) return;
    s.setAnimation(0, 'touch', false);
    s.addAnimation(0, current.current, true, 0);
  };
  return (
    <div
      className="spine-host"
      ref={host}
      onClick={touch}
      role="img"
      aria-label={`超宝数字形象：${{ sleep: '睡觉', idle: '待机', tail_wag: '说话中' }[stateAnimation(state)]}`}
    />
  );
}
