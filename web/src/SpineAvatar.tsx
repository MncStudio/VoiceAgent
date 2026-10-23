import { useEffect, useRef } from 'react';
import { SpinePlayer } from '@esotericsoftware/spine-player';
import type { AssistantState } from '../../shared/protocol';
import { cutsOnce, playsWake, stateAnimation } from './spineAnimation';

const base = '/avatar/cat-tv-robot/';
const labels: Record<string, string> = {
  sleep: '待唤醒',
  walk: '溜达中',
  idle: '待机',
  listen: '聆听中',
  speak: '说话中',
};
/**
 * 猫耳电视机器人（Spine 4.3）。hearing：用户正在说话（本地 VAD 或刚收到识别结果）；
 * walking：待命时在舞台上走动；touch 每变一次播一次摸头动作（点击 / 拖拽松手）。
 * 加载失败（无 WebGL / 资源缺失）时回调 onError，由外层换回默认形象。
 */
export function SpineAvatar({
  state,
  hearing,
  walking = false,
  touch = 0,
  onError,
}: {
  state: AssistantState;
  hearing: boolean;
  walking?: boolean;
  touch?: number;
  onError: () => void;
}) {
  const target = stateAnimation(state, hearing, walking);
  const host = useRef<HTMLDivElement>(null),
    player = useRef<SpinePlayer>(undefined),
    /** 当前状态对应的循环动画 */
    loop = useRef(target),
    /** 正在播的一次性动作（wake / touch），播完再回到 loop */
    once = useRef<string>(undefined),
    fail = useRef(onError);
  fail.current = onError;
  const playOnce = (name: string) => {
    const s = player.current?.animationState;
    if (!s) return;
    once.current = name;
    const entry = s.setAnimation(0, name, false);
    entry.listener = {
      complete: () => {
        if (once.current !== name || s.tracks[0] !== entry) return;
        once.current = undefined;
        s.setAnimation(0, loop.current, true);
      },
    };
  };
  useEffect(() => {
    if (!host.current) return;
    let disposed = false,
      blink: ReturnType<typeof setTimeout> | undefined;
    // 待机时在第 1 轨随机叠加眨眼，比 idle 自带的固定节奏更自然。
    const scheduleBlink = () => {
      blink = setTimeout(
        () => {
          const s = player.current?.animationState;
          if (s && !once.current && loop.current === 'idle') s.setAnimation(1, 'blink', false);
          scheduleBlink();
        },
        2200 + Math.random() * 3500,
      );
    };
    const p = new SpinePlayer(host.current, {
      skeleton: `${base}cat_tv_robot.json`,
      atlas: `${base}cat_tv_robot.atlas`,
      animation: loop.current,
      defaultMix: 0.2,
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
        // 加载期间状态可能已经变了
        sp.animationState!.setAnimation(0, loop.current, true);
        scheduleBlink();
      },
      error: (_sp, message) => {
        console.warn('[avatar] Spine 形象加载失败：', message);
        if (!disposed) fail.current();
      },
    });
    player.current = p;
    return () => {
      disposed = true;
      clearTimeout(blink);
      player.current = undefined;
      p.dispose();
    };
  }, []);
  useEffect(() => {
    const prev = loop.current;
    if (target === prev) return;
    loop.current = target;
    const s = player.current?.animationState;
    if (!s) return;
    if (playsWake(prev, target)) return playOnce('wake');
    // 唤醒 / 摸头动作还没播完：回到待机 / 睡眠就等它播完；聆听、说话、走路立刻切过去
    if (once.current && !cutsOnce(target)) return;
    once.current = undefined;
    s.setAnimation(0, target, true);
  }, [target]);
  useEffect(() => {
    if (touch && loop.current !== 'speak' && loop.current !== 'listen') playOnce('touch');
  }, [touch]);
  return (
    <div
      className="spine-host"
      ref={host}
      role="img"
      aria-label={`超宝数字形象：${labels[target]}`}
    />
  );
}
