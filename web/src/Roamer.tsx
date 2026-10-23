import React, { useEffect, useRef, useState } from 'react';
import {
  clamp,
  pauseMs,
  pickTarget,
  sleepAfterMs,
  step,
  walkAfterDragMs,
  walkAfterMs,
  type Rest,
} from './roam';

/**
 * 形象活动区。没唤醒（awake=false）时按作息给出 rest：眨眼待机 → 5 秒后来回走动 → 1 分钟后睡觉；
 * 唤醒期间原地不动。可以拖到任意位置：拖动中（任何状态）播摸头动作，松手后眨眼待机、2 秒后开始走动；
 * 直接点一下播一次摸头。
 */
export function Roamer({
  awake,
  children,
}: {
  awake: boolean;
  children: (p: { rest: Rest; touch: number; dragging: boolean }) => React.ReactNode;
}) {
  const area = useRef<HTMLDivElement>(null),
    body = useRef<HTMLDivElement>(null),
    pos = useRef<{ x: number; y: number }>(undefined),
    bounds = useRef({ x: 0, y: 0 }),
    target = useRef<number>(undefined),
    drag = useRef<{ id: number; sx: number; sy: number; x: number; y: number; moved: boolean }>(
      undefined,
    );
  /** 下一次待命作息开始后多久走动：刚被拖动放下时更快 */
  const nextWalkAfter = useRef(walkAfterMs);
  const [rest, setRest] = useState<Rest>('idle'),
    [facing, setFacing] = useState<1 | -1>(1),
    [dragging, setDragging] = useState(false),
    [touch, setTouch] = useState(0);
  const place = () => {
    if (pos.current && body.current)
      body.current.style.translate = `${pos.current.x}px ${pos.current.y}px`;
  };
  // 区域尺寸变化（窗口缩放、收起 / 展开面板）：按比例挪位置，首次放在中间
  useEffect(() => {
    const el = area.current;
    if (!el || !body.current) return;
    const measure = () => {
      const max = {
        x: Math.max(0, el.clientWidth - body.current!.offsetWidth),
        y: Math.max(0, el.clientHeight - body.current!.offsetHeight),
      };
      const old = bounds.current,
        p = pos.current;
      bounds.current = max;
      if (!p) pos.current = { x: max.x / 2, y: max.y * 0.6 };
      else {
        const k = (v: number, from: number, to: number) => (from ? (v / from) * to : to / 2);
        p.x = clamp(k(p.x, old.x, max.x), 0, max.x);
        p.y = clamp(k(p.y, old.y, max.y), 0, max.y);
        if (target.current !== undefined)
          target.current = clamp(k(target.current, old.x, max.x), 0, max.x);
      }
      place();
    };
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    observer.observe(body.current);
    return () => observer.disconnect();
  }, []);
  // 待命作息：眨眼待机 → 走动（与歇脚交替）→ 睡觉。唤醒或拖动时暂停，结束后从头开始。
  useEffect(() => {
    const walkAfter = nextWalkAfter.current;
    nextWalkAfter.current = walkAfterMs;
    setRest('idle');
    if (awake || dragging) return;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let timer: ReturnType<typeof setTimeout>,
      raf = 0,
      last = 0,
      asleep = false;
    const walk = (now: number) => {
      const p = pos.current,
        t = target.current;
      if (!p || t === undefined || asleep) return;
      const dt = Math.min(0.1, (now - (last || now)) / 1000);
      last = now;
      p.x = step(p.x, t, dt);
      place();
      if (p.x !== t) raf = requestAnimationFrame(walk);
      else {
        // 走到了，歇一会儿（眨眼待机）再走
        target.current = undefined;
        setRest('idle');
        timer = setTimeout(roam, pauseMs());
      }
    };
    const roam = () => {
      const p = pos.current;
      if (asleep) return;
      const t = p ? pickTarget(p.x, bounds.current.x) : undefined;
      if (!p || t === undefined || t === p.x) {
        timer = setTimeout(roam, pauseMs());
        return;
      }
      target.current = t;
      setFacing(t > p.x ? 1 : -1);
      setRest('walk');
      last = 0;
      raf = requestAnimationFrame(walk);
    };
    if (!still) timer = setTimeout(roam, walkAfter);
    const sleep = setTimeout(() => {
      asleep = true;
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      target.current = undefined;
      setRest('sleep');
    }, sleepAfterMs);
    return () => {
      clearTimeout(timer);
      clearTimeout(sleep);
      cancelAnimationFrame(raf);
      target.current = undefined;
    };
  }, [awake, dragging]);
  const down = (e: React.PointerEvent) => {
    if (e.button !== 0 || !pos.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      id: e.pointerId,
      sx: e.clientX,
      sy: e.clientY,
      x: pos.current.x,
      y: pos.current.y,
      moved: false,
    };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current,
      p = pos.current;
    if (!d || !p || d.id !== e.pointerId) return;
    const dx = e.clientX - d.sx,
      dy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) < 5) return;
    if (!d.moved) {
      d.moved = true;
      setDragging(true);
    }
    p.x = clamp(d.x + dx, 0, bounds.current.x);
    p.y = clamp(d.y + dy, 0, bounds.current.y);
    place();
  };
  const up = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = undefined;
    // 拖动后松手：眨眼待机，2 秒后开始走动
    if (d.moved) nextWalkAfter.current = walkAfterDragMs;
    setDragging(false);
    // 拖动过程中播摸头动作（见 dragging），松手回到当前状态；没拖动只是点一下就播一次
    if (!d.moved && e.type === 'pointerup') setTouch((n) => n + 1);
  };
  return (
    <div className="roam-area" ref={area}>
      <div
        ref={body}
        className={`roamer ${dragging ? 'dragging' : ''} ${rest === 'walk' ? 'walking' : ''}`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setTouch((n) => n + 1);
          }
        }}
        tabIndex={0}
        title="拖动或点一下超宝"
      >
        <div className={`roamer-body ${facing < 0 ? 'face-left' : ''}`}>
          {children({ rest, touch, dragging })}
        </div>
      </div>
    </div>
  );
}
