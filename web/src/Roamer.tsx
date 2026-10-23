import React, { useEffect, useRef, useState } from 'react';
import {
  clamp,
  dockAnimation,
  dockEdge,
  dockPos,
  pauseMs,
  pickTarget,
  sleepAfterMs,
  step,
  walkAfterDragMs,
  walkAfterMs,
  type Dock,
  type Rest,
} from './roam';

/**
 * 形象活动区。没唤醒（awake=false）时按作息给出 rest：眨眼待机 → 5 秒后来回走动 → 1 分钟后睡觉；
 * 唤醒期间原地不动。可以拖到任意位置：拖动中（任何状态）播摸头动作，松手后眨眼待机、2 秒后开始走动；
 * 直接点一下播一次摸头。
 * 没唤醒时拖到活动区边上松手就趴在那条边上（见 roam.ts 的 Dock），一直保持；唤醒时出来，
 * 问答结束后按正常作息待机 / 走动 / 睡觉，不会自己再进去。
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
    /** 形象框与活动区尺寸（趴边定位用） */
    dims = useRef({ size: { w: 0, h: 0 }, area: { w: 0, h: 0 } }),
    /** 当前趴着的边（与 dock 状态同步，供尺寸变化时重新定位） */
    docked = useRef<Dock>(undefined),
    target = useRef<number>(undefined),
    drag = useRef<{ id: number; sx: number; sy: number; x: number; y: number; moved: boolean }>(
      undefined,
    );
  /** 下一次待命作息开始后多久走动：刚被拖动放下时更快 */
  const nextWalkAfter = useRef(walkAfterMs);
  const [rest, setRest] = useState<Rest>('idle'),
    [facing, setFacing] = useState<1 | -1>(1),
    [dragging, setDragging] = useState(false),
    [touch, setTouch] = useState(0),
    [dock, setDockState] = useState<Dock>(),
    /** 拖动中松手会趴到哪条边，用来高亮那条边 */
    [hint, setHint] = useState<Dock>();
  const setDock = (d: Dock | undefined) => {
    docked.current = d;
    setDockState(d);
  };
  const place = () => {
    if (pos.current && body.current)
      body.current.style.translate = `${pos.current.x}px ${pos.current.y}px`;
  };
  /** 趴进 / 出来时平滑移过去，而不是瞬移 */
  const glide = () => {
    const el = body.current;
    if (!el || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    el.classList.add('gliding');
    setTimeout(() => el.classList.remove('gliding'), 450);
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
        p = pos.current,
        d = docked.current;
      bounds.current = max;
      dims.current = {
        size: { w: body.current!.offsetWidth, h: body.current!.offsetHeight },
        area: { w: el.clientWidth, h: el.clientHeight },
      };
      if (!p) pos.current = { x: max.x / 2, y: max.y * 0.6 };
      else {
        const k = (v: number, from: number, to: number) => (from ? (v / from) * to : to / 2);
        // 趴边时只按比例挪沿边方向，垂直边的方向重新贴到边上
        if (d !== 'left' && d !== 'right') p.x = clamp(k(p.x, old.x, max.x), 0, max.x);
        if (d !== 'top' && d !== 'bottom') p.y = clamp(k(p.y, old.y, max.y), 0, max.y);
        if (d) Object.assign(p, dockPos(d, p, dims.current.size, dims.current.area));
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
  // 唤醒时从边上出来：挪回活动区里，脸朝里
  useEffect(() => {
    const d = docked.current,
      p = pos.current;
    if (!awake || !d || !p) return;
    p.x = clamp(p.x, 0, bounds.current.x);
    p.y = clamp(p.y, 0, bounds.current.y);
    if (d === 'left' || d === 'right') setFacing(d === 'left' ? 1 : -1);
    setDock(undefined);
    glide();
    place();
  }, [awake]);
  // 待命作息：眨眼待机 → 走动（与歇脚交替）→ 睡觉。唤醒或拖动时暂停，结束后从头开始。
  // 趴在边上时一直保持趴边动作，不走动也不睡觉。
  useEffect(() => {
    if (dock && !awake && !dragging) {
      setRest(dockAnimation(dock));
      return;
    }
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
  }, [awake, dragging, dock]);
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
      // 从边上拖出来：从活动区里离它最近的位置开始跟手
      if (docked.current) {
        d.x = clamp(d.x, 0, bounds.current.x);
        d.y = clamp(d.y, 0, bounds.current.y);
        setDock(undefined);
      }
    }
    p.x = clamp(d.x + dx, 0, bounds.current.x);
    p.y = clamp(d.y + dy, 0, bounds.current.y);
    place();
    // 唤醒期间不趴边
    setHint(awake ? undefined : dockEdge(p, bounds.current));
  };
  const up = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = undefined;
    setHint(undefined);
    // 拖动后松手：眨眼待机，2 秒后开始走动
    if (d.moved) nextWalkAfter.current = walkAfterDragMs;
    setDragging(false);
    const p = pos.current,
      edge = p && d.moved && !awake && e.type === 'pointerup' && dockEdge(p, bounds.current);
    // 拖到边上松手：趴到那条边上
    if (p && edge) {
      Object.assign(p, dockPos(edge, p, dims.current.size, dims.current.area));
      setDock(edge);
      glide();
      place();
    }
    // 拖动过程中播摸头动作（见 dragging），松手回到当前状态；没拖动只是点一下就播一次（趴着时不播）
    if (!d.moved && e.type === 'pointerup' && !docked.current) setTouch((n) => n + 1);
  };
  return (
    <div className={`roam-area ${hint ? `hint-${hint}` : ''}`} ref={area}>
      <div
        ref={body}
        className={`roamer ${dragging ? 'dragging' : ''} ${rest === 'walk' ? 'walking' : ''} ${dock ? 'docked' : ''}`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (!docked.current) setTouch((n) => n + 1);
          }
        }}
        tabIndex={0}
        title="拖动或点一下超宝"
      >
        <div className={`roamer-body ${dock ? `dock-${dock}` : facing < 0 ? 'face-left' : ''}`}>
          {children({ rest, touch, dragging })}
        </div>
      </div>
    </div>
  );
}
