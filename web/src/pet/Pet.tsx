import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import type { AssistantState } from '../../../shared/protocol';
import { PetSprite, type Pose } from './PetSprite';
import type { Skin } from './skins';
import './pet.css';

/** 桌宠在空闲时自己安排的小活动。 */
type Activity = { pose: Pose; until: number; target?: number; line?: string; tag?: string };
type Effect = { id: number; kind: 'heart' | 'spark'; dx: number };

const idleTags: Partial<Record<Pose, string>> = {
  sit: '陪着你',
  look: '东张西望',
  walk: '桌面巡逻中',
  work: '陪你一起工作中…',
  drink: '休息时间 ☕',
  stretch: '活动一下',
  wave: '嗨～',
  sleep: '打盹中 Zzz',
  happy: '开心！',
};
const lines = (wakeWord: string): Partial<Record<Pose, string[]>> => ({
  sit: ['今天也一起加油吧', '有事随时叫我～', `叫我「${wakeWord}」就行`],
  look: ['咦，那边有什么？', '让我看看今天有什么新任务'],
  walk: ['溜达溜达～', '巡逻一下桌面'],
  work: ['整理库存数据中…', '帮你盯着数据呢', '一起把活儿干完！'],
  drink: ['喝口咖啡歇一下 ☕', '补充能量中…'],
  stretch: ['伸个懒腰～', '坐久了要活动活动哦'],
  wave: ['嗨～我在这儿！', `想聊天就喊「${wakeWord}」`],
  sleep: ['呼噜呼噜… Zzz', '小睡一会儿，点我就醒'],
});
const pick = <T,>(items: T[]) => items[Math.floor(Math.random() * items.length)];
/** 加权随机挑下一项活动（走路最常见，挥手最少）。 */
const plan: [Pose, number, [number, number]][] = [
  ['walk', 30, [0, 0]],
  ['sit', 16, [4000, 8000]],
  ['look', 12, [3500, 6000]],
  ['work', 16, [7000, 14000]],
  ['drink', 10, [5000, 8000]],
  ['stretch', 8, [2600, 2600]],
  ['wave', 6, [2400, 2400]],
];
/** 对话状态优先于空闲活动。 */
const statePose: Partial<Record<AssistantState, Pose>> = {
  CANDIDATE: 'alert',
  LISTENING: 'listen',
  THINKING: 'work',
  SPEAKING: 'talk',
  INTERRUPT: 'alert',
};
const stateTags: Partial<Record<AssistantState, string>> = {
  CANDIDATE: '是在叫我吗？',
  LISTENING: '正在聆听',
  THINKING: '努力思考中…',
  SPEAKING: '为你解答',
  INTERRUPT: '好的，你说',
};
const SLEEP_AFTER = 90_000;
const SPEED = 70; // px/s

export type PetProps = {
  skin: Skin;
  state: AssistantState;
  /** 播报音量（口型）0..1 */
  mouth: number;
  voice: boolean;
  wakeWord: string;
  headline: string;
  live: string;
  partial: boolean;
  /** 主标题是否必须显示（对话中 / 追问窗口内），否则空闲时让位给桌宠的自言自语。 */
  important: boolean;
  onWake: () => void;
};

export function Pet(props: PetProps) {
  const { skin, state, mouth, voice, wakeWord, onWake } = props;
  const stage = useRef<HTMLDivElement>(null),
    body = useRef<HTMLDivElement>(null),
    bubble = useRef<HTMLDivElement>(null);
  const reduced = useRef(
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  // 位置在 rAF 里直接写 CSS 变量，避免每帧重渲染。
  const pos = useRef({ x: -1, y: 0, vy: 0 });
  const [activity, setActivity] = useState<Activity>({
    pose: 'wave',
    until: Date.now() + 2600,
    line: `你好，我是超宝～`,
    tag: '你好！',
  });
  const act = useRef(activity);
  act.current = activity;
  const [facing, setFacing] = useState<1 | -1>(1);
  const [drag, setDrag] = useState<'none' | 'hold' | 'fall'>('none');
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const [effects, setEffects] = useState<Effect[]>([]);
  const lastTouch = useRef(Date.now());
  const prevState = useRef(state);
  const stateRef = useRef(state);
  stateRef.current = state;

  const go = (next: Activity) => {
    act.current = next;
    setActivity(next);
  };
  const burst = (kind: Effect['kind'], n = 3) => {
    const born = Array.from({ length: n }, (_, i) => ({
      id: Math.random(),
      kind,
      dx: (i - (n - 1) / 2) * 22 + (Math.random() - 0.5) * 10,
    }));
    setEffects((list) => [...list, ...born]);
    setTimeout(() => setEffects((list) => list.filter((e) => !born.includes(e))), 1500);
  };

  // 空闲时的小脑袋：到点就换下一件事；久不互动就睡觉。
  useEffect(() => {
    const tick = () => {
      if (stateRef.current !== 'IDLE' || dragRef.current !== 'none') return;
      const now = Date.now(),
        cur = act.current;
      if (cur.pose === 'sleep') return;
      if (now - lastTouch.current > SLEEP_AFTER) {
        go({ pose: 'sleep', until: Infinity, line: pick(lines(wakeWord).sleep!) });
        return;
      }
      if (now < cur.until) return;
      const total = plan.reduce((s, p) => s + p[1], 0);
      let r = Math.random() * total;
      const choice = plan.find((p) => (r -= p[1]) <= 0) ?? plan[0];
      let [pose] = choice;
      const [a, b] = choice[2];
      if (pose === cur.pose && pose !== 'walk') pose = 'sit';
      const w = stage.current?.clientWidth ?? 800;
      if (pose === 'walk' && reduced.current) pose = 'sit';
      const speak = Math.random() < 0.55;
      if (pose === 'walk') {
        const margin = Math.min(120, w * 0.14);
        let target = margin + Math.random() * (w - margin * 2);
        if (Math.abs(target - pos.current.x) < 80) target = w - target;
        setFacing(target >= pos.current.x ? 1 : -1);
        go({
          pose,
          until: Infinity,
          target,
          line: speak ? pick(lines(wakeWord).walk!) : undefined,
        });
      } else
        go({
          pose,
          until: now + a + Math.random() * (b - a),
          line: speak || pose === 'wave' ? pick(lines(wakeWord)[pose] ?? ['']) : undefined,
        });
    };
    const timer = setInterval(tick, 300);
    return () => clearInterval(timer);
  }, [wakeWord]);

  // 对话状态切换：开口时站定看向用户；答完小小庆祝一下。
  useEffect(() => {
    const prev = prevState.current;
    prevState.current = state;
    if (state !== 'IDLE') {
      lastTouch.current = Date.now();
      if (act.current.pose === 'walk' || act.current.pose === 'sleep')
        go({ pose: 'sit', until: 0 });
      return;
    }
    if (prev === 'SPEAKING') {
      go({ pose: 'happy', until: Date.now() + 2600, line: '搞定啦！', tag: 'Good job ✨' });
      burst('spark', 3);
    } else if (prev !== 'IDLE') go({ pose: 'sit', until: Date.now() + 2500 });
  }, [state]);

  // 位置 / 走路 / 下落的帧循环。
  useEffect(() => {
    let raf = 0,
      last = performance.now();
    const frame = (t: number) => {
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      const el = body.current,
        st = stage.current;
      if (el && st) {
        const w = st.clientWidth,
          half = el.clientWidth / 2,
          p = pos.current;
        if (p.x < 0) p.x = w * 0.5;
        const cur = act.current;
        if (
          cur.pose === 'walk' &&
          cur.target !== undefined &&
          stateRef.current === 'IDLE' &&
          dragRef.current === 'none'
        ) {
          const d = cur.target - p.x,
            step = SPEED * dt;
          if (Math.abs(d) <= step) {
            p.x = cur.target;
            go({ ...cur, until: 0, target: undefined });
          } else p.x += Math.sign(d) * step;
        }
        if (dragRef.current === 'fall') {
          p.vy += 2600 * dt;
          p.y += p.vy * dt;
          if (p.y >= 0) {
            p.y = 0;
            if (p.vy > 420) p.vy = -p.vy * 0.32;
            else {
              p.vy = 0;
              setDrag('none');
              dragRef.current = 'none';
              go({ pose: 'sit', until: Date.now() + 3000, line: '呼～安全着陆', tag: '着陆成功' });
            }
          }
        }
        p.x = Math.max(half * 0.6, Math.min(w - half * 0.6, p.x));
        el.style.setProperty('--x', `${p.x - half}px`);
        el.style.setProperty('--y', `${p.y}px`);
        el.style.setProperty('--lift', `${Math.min(1, -p.y / 260)}`);
        const b = bubble.current;
        if (b) {
          const bw = b.offsetWidth,
            left = p.x - bw / 2,
            clamped = Math.max(10, Math.min(w - bw - 10, left));
          el.style.setProperty('--shift', `${clamped - left}px`);
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  // 眼睛跟随鼠标。
  useEffect(() => {
    const move = (e: globalThis.PointerEvent) => {
      const el = body.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const lx = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / 400));
      const ly = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height * 0.35)) / 400));
      el.style.setProperty('--lx', lx.toFixed(2));
      el.style.setProperty('--ly', ly.toFixed(2));
    };
    addEventListener('pointermove', move);
    return () => removeEventListener('pointermove', move);
  }, []);

  // 拖拽：按住拎起来，松手会掉回桌面弹两下；没拖动就算点击。
  const press = useRef<{ x: number; y: number; px: number; py: number; moved: boolean }>(undefined);
  const down = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    press.current = {
      x: e.clientX,
      y: e.clientY,
      px: pos.current.x,
      py: pos.current.y,
      moved: false,
    };
  };
  const move = (e: PointerEvent) => {
    const p = press.current;
    if (!p) return;
    const dx = e.clientX - p.x,
      dy = e.clientY - p.y;
    if (!p.moved && Math.hypot(dx, dy) < 6) return;
    if (!p.moved) {
      p.moved = true;
      setDrag('hold');
      dragRef.current = 'hold';
      lastTouch.current = Date.now();
    }
    const h = stage.current?.clientHeight ?? 400;
    pos.current.x = p.px + dx;
    pos.current.y = Math.max(-h + 120, Math.min(0, p.py + dy));
    pos.current.vy = 0;
  };
  const up = () => {
    const p = press.current;
    press.current = undefined;
    if (!p) return;
    lastTouch.current = Date.now();
    if (p.moved) {
      setDrag('fall');
      dragRef.current = 'fall';
      return;
    }
    if (act.current.pose === 'sleep') {
      go({ pose: 'stretch', until: Date.now() + 2600, line: '唔…我醒啦', tag: '醒啦' });
      return;
    }
    burst('heart');
    if (voice) onWake();
    else if (state === 'IDLE')
      go({
        pose: 'happy',
        until: Date.now() + 2200,
        line: pick(['嘿嘿，被摸头了', '最喜欢你啦～', '连接麦克风后，点我就能说话']),
        tag: '摸摸头',
      });
  };

  const busy = state !== 'IDLE';
  const pose: Pose =
    drag === 'hold'
      ? 'drag'
      : drag === 'fall'
        ? 'fall'
        : (busy && statePose[state]) || activity.pose;
  const tag =
    drag !== 'none'
      ? undefined
      : busy
        ? stateTags[state]
        : (activity.tag ?? idleTags[activity.pose]);
  const headline =
    drag === 'hold'
      ? '放我下来啦～'
      : !props.important && activity.line
        ? activity.line
        : props.headline;
  return (
    <div className="pet-stage" ref={stage}>
      <div
        className={`pet pet-${pose} ${busy ? 'is-busy' : ''} ${drag !== 'none' ? 'is-dragging' : ''}`}
        ref={body}
        style={{ '--face': facing } as CSSProperties}
      >
        <div className={`pet-bubble ${busy || props.partial ? 'wide' : ''}`} ref={bubble}>
          <h1>{headline}</h1>
          <p className={`live-text ${props.partial ? 'is-partial' : ''}`} aria-live="polite">
            {props.live}
            {props.partial && <span className="typing-cursor" />}
          </p>
        </div>
        <div className="pet-ground-shadow" aria-hidden="true" />
        <div className="pet-lift">
          <div className="pet-fx" aria-hidden="true">
            {pose === 'sleep' && (
              <span className="fx-zzz">
                <i>z</i>
                <i>z</i>
                <i>Z</i>
              </span>
            )}
            {pose === 'alert' && (
              <span className="fx-mark">{state === 'INTERRUPT' ? '!' : '?'}</span>
            )}
            {pose === 'listen' && (
              <span className="fx-waves">
                <i />
                <i />
                <i />
              </span>
            )}
            {effects.map((fx) => (
              <span
                key={fx.id}
                className={`fx-${fx.kind}`}
                style={{ '--dx': `${fx.dx}px` } as CSSProperties}
              >
                {fx.kind === 'heart' ? '♥' : '✦'}
              </span>
            ))}
          </div>
          <button
            type="button"
            className="pet-hit"
            aria-label={voice ? `点我唤醒${skin.name}` : `摸摸${skin.name}`}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                press.current = { x: 0, y: 0, px: 0, py: 0, moved: false };
                up();
              }
            }}
          >
            <div className={`pet-flip ${facing < 0 ? 'left' : ''}`}>
              <PetSprite skin={skin} pose={pose} mouth={pose === 'talk' ? mouth : 0} />
            </div>
          </button>
        </div>
        {tag && <span className="pet-tag">{tag}</span>}
      </div>
    </div>
  );
}
