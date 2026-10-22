import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { AssistantState } from '../../../shared/protocol';
import type { Pose } from '../pet/PetSprite';
import type { Skin } from '../pet/skins';
import { PetWorld } from './world';
import '../pet/pet.css';
import './pet3d.css';

type Activity = { pose: Pose; until: number; walk?: number; line?: string; tag?: string };
type Effect = { id: number; kind: 'heart' | 'spark'; dx: number };

const idleTags: Partial<Record<Pose, string>> = {
  sit: '陪着你',
  look: '东张西望',
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
const plan: [Pose, number, [number, number]][] = [
  ['walk', 28, [0, 0]],
  ['sit', 16, [4000, 8000]],
  ['look', 12, [3500, 6000]],
  ['work', 18, [8000, 15000]],
  ['drink', 10, [6000, 9000]],
  ['stretch', 8, [2600, 2600]],
  ['wave', 6, [2400, 2400]],
];
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

export type Pet3DProps = {
  skin: Skin;
  night: boolean;
  state: AssistantState;
  mouth: number;
  micLevel: number;
  voice: boolean;
  wakeWord: string;
  headline: string;
  live: string;
  partial: boolean;
  important: boolean;
  /** 右侧面板遮挡宽度（px） */
  side: number;
  notes: string[];
  onNote: (text: string) => void;
  onWake: () => void;
};

/** 3D 桌宠：小脑袋（安排活动、响应对话状态）+ 对话气泡等 HTML 叠层。 */
export function Pet3D(props: Pet3DProps) {
  const { skin, state, voice, wakeWord } = props;
  const host = useRef<HTMLDivElement>(null),
    overlay = useRef<HTMLDivElement>(null),
    bubble = useRef<HTMLDivElement>(null);
  const world = useRef<PetWorld | undefined>(undefined);
  const reduced = useRef(
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const [activity, setActivity] = useState<Activity>({
    pose: 'wave',
    until: Date.now() + 2600,
    line: '你好，我是超宝～',
    tag: '你好！',
  });
  const act = useRef(activity);
  const [drag, setDrag] = useState(false);
  const [effects, setEffects] = useState<Effect[]>([]);
  const lastTouch = useRef(Date.now());
  const prevState = useRef(state);
  const latest = useRef(props);
  latest.current = props;

  const go = (next: Activity) => {
    act.current = next;
    setActivity(next);
    if (next.walk !== undefined) world.current?.walkTo(next.walk);
  };
  const burst = (kind: Effect['kind'], n = 3) => {
    const born = Array.from({ length: n }, (_, i) => ({
      id: Math.random(),
      kind,
      dx: (i - (n - 1) / 2) * 24 + (Math.random() - 0.5) * 10,
    }));
    setEffects((list) => [...list, ...born]);
    setTimeout(() => setEffects((list) => list.filter((e) => !born.includes(e))), 1500);
  };

  // 创建 3D 世界
  useEffect(() => {
    const w = new PetWorld(host.current!, latest.current.skin, latest.current.night, {
      onArrive: () => {
        if (act.current.walk !== undefined)
          go({ pose: 'sit', until: Date.now() + 1500 + Math.random() * 2500 });
      },
      onClick: () => {
        lastTouch.current = Date.now();
        if (act.current.pose === 'sleep') {
          go({ pose: 'stretch', until: Date.now() + 2600, line: '唔…我醒啦', tag: '醒啦' });
          return;
        }
        burst('heart');
        if (latest.current.voice) latest.current.onWake();
        else if (latest.current.state === 'IDLE')
          go({
            pose: 'happy',
            until: Date.now() + 2200,
            line: pick(['嘿嘿，被摸头了', '最喜欢你啦～', '连接麦克风后，点我就能说话']),
            tag: '摸摸头',
          });
      },
      onDragStart: () => {
        lastTouch.current = Date.now();
        setDrag(true);
      },
      onLand: () => {
        setDrag(false);
        lastTouch.current = Date.now();
        go({ pose: 'sit', until: Date.now() + 3000, line: '呼～安全着陆', tag: '着陆成功' });
      },
      onNote: (text) => latest.current.onNote(text),
      onFrame: ({ head, foot }) => {
        const o = overlay.current,
          b = bubble.current;
        if (!o) return;
        o.style.setProperty('--hx', `${head.x}px`);
        o.style.setProperty('--hy', `${head.y}px`);
        o.style.setProperty('--fx', `${foot.x}px`);
        o.style.setProperty('--fy', `${foot.y}px`);
        if (b) {
          const bw = b.offsetWidth,
            maxX = o.clientWidth - latest.current.side - bw - 12,
            left = head.x - bw / 2;
          o.style.setProperty('--shift', `${Math.max(12, Math.min(maxX, left)) - left}px`);
        }
      },
    });
    world.current = w;
    w.setNotes(latest.current.notes);
    w.setPose(act.current.pose);
    return () => {
      w.dispose();
      world.current = undefined;
    };
  }, []);
  useEffect(() => world.current?.setSkin(skin), [skin]);
  useEffect(() => world.current?.setNight(props.night), [props.night]);
  useEffect(() => world.current?.setSide(props.side), [props.side]);
  useEffect(() => world.current?.setNotes(props.notes), [props.notes.join('|')]);
  useEffect(() => {
    world.current?.setMouth(props.mouth);
    world.current?.setLevel(props.micLevel);
  });

  // 空闲时安排活动；久不互动就睡觉
  useEffect(() => {
    const tick = () => {
      if (latest.current.state !== 'IDLE' || world.current?.dragging) return;
      const now = Date.now(),
        cur = act.current;
      if (cur.pose === 'sleep' || cur.walk !== undefined) return;
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
      if (pose === cur.pose) pose = 'sit';
      if (pose === 'walk' && reduced.current) pose = 'look';
      const speak = Math.random() < 0.55;
      if (pose === 'walk') {
        let to = Math.random();
        const here = world.current?.position ?? 0.5;
        if (Math.abs(to - here) < 0.2) to = 1 - to;
        go({
          pose: 'sit',
          walk: to,
          until: Infinity,
          line: speak ? pick(lines(wakeWord).walk!) : undefined,
          tag: '桌面巡逻中',
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

  // 对话状态切换
  useEffect(() => {
    const prev = prevState.current;
    prevState.current = state;
    if (state !== 'IDLE') {
      lastTouch.current = Date.now();
      world.current?.stop();
      if (act.current.walk !== undefined || act.current.pose === 'sleep')
        go({ pose: 'sit', until: 0 });
      return;
    }
    if (prev === 'SPEAKING') {
      go({ pose: 'happy', until: Date.now() + 2600, line: '搞定啦！', tag: 'Good job ✨' });
      burst('spark', 3);
    } else if (prev !== 'IDLE') go({ pose: 'sit', until: Date.now() + 2500 });
  }, [state]);

  const busy = state !== 'IDLE';
  const pose: Pose = (busy && statePose[state]) || activity.pose;
  useEffect(() => world.current?.setPose(pose), [pose]);
  const tag = drag
    ? undefined
    : busy
      ? stateTags[state]
      : (activity.tag ?? idleTags[activity.pose]);
  const headline = drag
    ? '放我下来啦～'
    : !props.important && activity.line
      ? activity.line
      : props.headline;
  return (
    <div className="pet3d">
      <div className="pet3d-canvas" ref={host} />
      <div className={`pet3d-overlay ${busy ? 'is-busy' : ''}`} ref={overlay}>
        <div className={`pet-bubble ${busy || props.partial ? 'wide' : ''}`} ref={bubble}>
          <h1>{headline}</h1>
          <p className={`live-text ${props.partial ? 'is-partial' : ''}`} aria-live="polite">
            {props.live}
            {props.partial && <span className="typing-cursor" />}
          </p>
        </div>
        <div className="pet-fx" aria-hidden="true">
          {pose === 'sleep' && (
            <span className="fx-zzz">
              <i>z</i>
              <i>z</i>
              <i>Z</i>
            </span>
          )}
          {pose === 'alert' && <span className="fx-mark">{state === 'INTERRUPT' ? '!' : '?'}</span>}
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
        {tag && <span className="pet-tag">{tag}</span>}
        <button
          type="button"
          className="pet3d-a11y"
          aria-label={voice ? `点我唤醒${skin.name}` : `摸摸${skin.name}`}
          onClick={() => {
            lastTouch.current = Date.now();
            burst('heart');
            if (voice) props.onWake();
          }}
        />
      </div>
    </div>
  );
}
