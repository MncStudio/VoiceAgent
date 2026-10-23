import React, { useEffect, useRef, useState } from 'react';
import { clamp, napMs, pickTarget, step } from './roam';

/**
 * 形象活动区：active（待命）时打盹和随机走动交替；可以拖到任意位置，
 * 拖动中（任何状态）播摸头动作，直接点一下播一次。非待命状态原地不动。
 */
export function Roamer({
  active,
  children,
}: {
  active: boolean;
  children: (p: { walking: boolean; touch: number; dragging: boolean }) => React.ReactNode;
}) {
  const area = useRef<HTMLDivElement>(null),
    body = useRef<HTMLDivElement>(null),
    pos = useRef<{ x: number; y: number }>(undefined),
    bounds = useRef({ x: 0, y: 0 }),
    target = useRef<number>(undefined),
    drag = useRef<{ id: number; sx: number; sy: number; x: number; y: number; moved: boolean }>(
      undefined,
    );
  const [walking, setWalking] = useState(false),
    [facing, setFacing] = useState<1 | -1>(1),
    [dragging, setDragging] = useState(false),
    [touch, setTouch] = useState(0),
    [rest, setRest] = useState(0);
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
  // 打盹 → 走动 → 打盹……
  useEffect(() => {
    if (!active || dragging || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let timer: ReturnType<typeof setTimeout>,
      raf = 0,
      last = 0;
    const walk = (now: number) => {
      const p = pos.current,
        t = target.current;
      if (!p || t === undefined) return;
      const dt = Math.min(0.1, (now - (last || now)) / 1000);
      last = now;
      p.x = step(p.x, t, dt);
      place();
      if (p.x !== t) raf = requestAnimationFrame(walk);
      else {
        target.current = undefined;
        setWalking(false);
        nap();
      }
    };
    const nap = (ms = napMs()) => {
      timer = setTimeout(() => {
        const p = pos.current;
        if (!p) return nap();
        const t = pickTarget(p.x, bounds.current.x);
        if (t === p.x) return nap();
        target.current = t;
        setFacing(t > p.x ? 1 : -1);
        setWalking(true);
        last = 0;
        raf = requestAnimationFrame(walk);
      }, ms);
    };
    // 刚打开页面 / 刚被放下时先歇一会儿再走
    nap(rest ? napMs() : 3000 + Math.random() * 2000);
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      target.current = undefined;
      setWalking(false);
    };
  }, [active, dragging, rest]);
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
    setDragging(false);
    setRest((n) => n + 1);
    // 拖动过程中播摸头动作（见 dragging），松手回到当前状态；没拖动只是点一下就播一次
    if (!d.moved && e.type === 'pointerup') setTouch((n) => n + 1);
  };
  return (
    <div className="roam-area" ref={area}>
      <div
        ref={body}
        className={`roamer ${dragging ? 'dragging' : ''} ${walking ? 'walking' : ''}`}
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
          {children({ walking, touch, dragging })}
        </div>
      </div>
    </div>
  );
}
