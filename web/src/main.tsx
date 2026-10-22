import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AssistantClient, type AppConfig } from './client';
import { Avatar } from './Avatar';
import { Pet } from './pet/Pet';
import { PetSprite } from './pet/PetSprite';
import { Scene } from './pet/Scene';
import { skins, type SkinId } from './pet/skins';
import { Gallery } from './pet/Gallery';
import { Pet3D } from './pet3d/Pet3D';
import { hasWebGL, snapshots } from './pet3d/world';
const webgl = hasWebGL();

const thumbs: Partial<Record<SkinId, string>> = {};
/** 设置面板里的形象缩略图：有 WebGL 时离屏渲染一张 3D 照片（缓存），否则用平面版。 */
function SkinThumb({ skin }: { skin: (typeof skins)[SkinId] }) {
  const [src, setSrc] = useState(thumbs[skin.id]);
  useEffect(() => {
    if (!webgl || src) return;
    const t = setTimeout(() => {
      try {
        thumbs[skin.id] ??= snapshots(skin, ['sit'], 240, 280)[0];
        setSrc(thumbs[skin.id]);
      } catch {
        /* 渲染失败就继续用平面版 */
      }
    }, 60);
    return () => clearTimeout(t);
  }, [skin, src]);
  return src ? (
    <img className="skin-thumb" src={src} alt="" />
  ) : (
    <PetSprite skin={skin} pose="sit" mouth={0} />
  );
}
import type { AudioStatus } from './audio';
import type { AssistantState, ServerEvent } from '../../shared/protocol';
import './style.css';
const labels: Record<AssistantState, string> = {
  IDLE: '待命中',
  CANDIDATE: '听到呼唤',
  LISTENING: '正在聆听',
  THINKING: '思考中',
  SPEAKING: '正在回答',
  INTERRUPT: '已打断',
};
const headlines: Record<AssistantState, string> = {
  IDLE: '',
  CANDIDATE: '是在叫我吗？',
  LISTENING: '我在听，请说',
  THINKING: '让我想一想…',
  SPEAKING: '',
  INTERRUPT: '好的，你说',
};
const SKIN_KEY = 'chaobao.skin',
  THEME_KEY = 'chaobao.theme';
type Theme = 'auto' | 'day' | 'night';
const params = new URLSearchParams(location.search);
const stored = (key: string) => {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
};
const initialSkin = (): SkinId => {
  const id = params.get('skin') ?? stored(SKIN_KEY);
  return id && id in skins ? (id as SkinId) : 'neko';
};
const initialTheme = (): Theme => {
  const id = params.get('theme') ?? stored(THEME_KEY);
  return id === 'day' || id === 'night' ? id : 'auto';
};
const suggestions = ['介绍一下你自己', '帮我整理今天的工作思路', '如何在回答时打断你？'];
type Entry = { id: string; role: 'user' | 'assistant'; text: string; interrupted?: boolean };
function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    mic: (
      <>
        <rect x="9" y="2" width="6" height="12" rx="3" />
        <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" />
      </>
    ),
    send: (
      <>
        <path d="m3 3 19 9-19 9 4-9-4-9Zm4 9h15" />
      </>
    ),
    stop: (
      <>
        <path d="M9 5v14M15 5v14" />
      </>
    ),
    settings: (
      <>
        <path d="M4 7h16M4 17h16" />
        <circle cx="9" cy="7" r="3" />
        <circle cx="15" cy="17" r="3" />
      </>
    ),
    arrow: <path d="m9 5 7 7-7 7" />,
    refresh: (
      <>
        <path d="M20 7v5h-5M4 17v-5h5" />
        <path d="M6 6a8 8 0 0 1 14 6M4 12a8 8 0 0 0 14 6" />
      </>
    ),
    close: <path d="m6 6 12 12M6 18 18 6" />,
    chat: (
      <>
        <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.6A8 8 0 1 1 21 12Z" />
        <path d="M8.5 10.5h7M8.5 13.5h4.5" />
      </>
    ),
    micOff: (
      <>
        <path d="M15 9.3V5a3 3 0 0 0-5.7-1.3M9 9v3a3 3 0 0 0 4.6 2.5" />
        <path d="M19 10v2a7 7 0 0 1-.9 3.4M5 10v2a7 7 0 0 0 11.2 5.6M12 19v3m-4 0h8M3 3l18 18" />
      </>
    ),
    square: <rect x="7" y="7" width="10" height="10" rx="2.5" />,
    shield: (
      <>
        <path d="m12 2 9 4v6c0 6-9 10-9 10S3 18 3 12V6l9-4Z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.mic}
    </svg>
  );
}
function App() {
  const [config, setConfig] = useState<AppConfig>();
  const [state, setState] = useState<AssistantState>('IDLE');
  const [connected, setConnected] = useState(false),
    [voice, setVoice] = useState(false),
    [busy, setBusy] = useState(false);
  const [input, setInput] = useState(''),
    [entries, setEntries] = useState<Entry[]>([]),
    [partial, setPartial] = useState('');
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [settings, setSettings] = useState(false),
    [historyOpen, setHistoryOpen] = useState(() => innerWidth >= 1100);
  const [audio, setAudio] = useState<AudioStatus>(),
    [level, setLevel] = useState(0),
    [followup, setFollowup] = useState(0),
    [now, setNow] = useState(Date.now());
  const [latency, setLatency] = useState<number>(),
    [vrm, setVrm] = useState<string>();
  const [skinId, setSkinId] = useState<SkinId>(initialSkin),
    [theme, setTheme] = useState<Theme>(initialTheme);
  const hour = new Date(now).getHours();
  const [wide, setWide] = useState(() => innerWidth >= 1100);
  useEffect(() => {
    const onResize = () => setWide(innerWidth >= 1100);
    addEventListener('resize', onResize);
    return () => removeEventListener('resize', onResize);
  }, []);
  const client = useRef<AssistantClient | undefined>(undefined),
    list = useRef<HTMLDivElement>(null);
  const activeAnswer = useRef<string | undefined>(undefined);
  // 清空对话后，仍在路上的旧回答增量不能把消息“复活”。
  const discarded = useRef(new Set<string>());
  // 断线自动重连需要读取最新的配置与语音开关，不能依赖渲染时的闭包。
  const configRef = useRef<AppConfig | undefined>(undefined),
    voiceRef = useRef(false),
    recovering = useRef(false),
    unmounted = useRef(false);
  configRef.current = config;
  voiceRef.current = voice;
  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then(setConfig)
      .catch(() => setError('无法连接服务端，请检查 npm run dev 是否已启动。'));
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => {
      unmounted.current = true;
      clearInterval(timer);
      void client.current?.close();
    };
  }, []);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' });
  }, [entries, partial]);
  const onEvent = (e: ServerEvent) => {
    if (e.type === 'state') {
      setState(e.state);
      setFollowup(e.followupUntil ?? 0);
    }
    if (e.type === 'transcript') {
      setPartial(e.text);
      if (e.final) {
        setEntries((items) => [...items, { id: crypto.randomUUID(), role: 'user', text: e.text }]);
        setPartial('');
      }
    }
    if (e.type === 'delta') {
      if (discarded.current.has(e.turnId)) return;
      if (activeAnswer.current !== e.turnId) {
        activeAnswer.current = e.turnId;
        setPartial('');
      }
      setEntries((items) => {
        const found = items.find((x) => x.id === e.turnId);
        return found
          ? items.map((x) => (x.id === e.turnId ? { ...x, text: x.text + e.text } : x))
          : [...items, { id: e.turnId, role: 'assistant', text: e.text }];
      });
    }
    if (e.type === 'interrupted')
      setEntries((items) =>
        items.map((x) =>
          x.id === e.turnId ? { ...x, text: x.text.slice(0, e.heardChars), interrupted: true } : x,
        ),
      );
    if (e.type === 'metrics' && e.name === 'firstAudio') setLatency(e.ms);
    if (e.type === 'notice') setNotice(e.message);
    if (e.type === 'error') setError(e.message);
  };
  const recover = async () => {
    if (recovering.current || unmounted.current) return;
    recovering.current = true;
    const old = client.current;
    client.current = undefined;
    setConnected(false);
    setState('IDLE');
    await old?.close().catch(() => {});
    for (let attempt = 0; !unmounted.current; attempt++) {
      setNotice('连接中断，正在自动重连…');
      await new Promise((r) => setTimeout(r, Math.min(15000, 1000 * 2 ** attempt)));
      const next = new AssistantClient(onEvent, setAudio, setLevel, () => void recover());
      try {
        await next.connect();
        if (voiceRef.current && configRef.current) await next.enableVoice(configRef.current);
        client.current = next;
        setConnected(true);
        setError('');
        setNotice('已重新连接。');
        break;
      } catch {
        await next.close().catch(() => {});
      }
    }
    recovering.current = false;
  };
  const ensure = async () => {
    if (client.current && connected) return client.current;
    const next = new AssistantClient(onEvent, setAudio, setLevel, () => void recover());
    await next.connect();
    client.current = next;
    setConnected(true);
    return next;
  };
  const connectVoice = async () => {
    if (busy || !config) return;
    setBusy(true);
    setError('');
    try {
      if (voice) {
        await client.current?.close();
        client.current = undefined;
        setConnected(false);
        setVoice(false);
        setAudio(undefined);
        setState('IDLE');
      } else {
        const c = await ensure();
        await c.enableVoice(config);
        setVoice(true);
        setNotice(`麦克风已连接。说“${config.wakeWord}”，也可以点击下方按钮开始。`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '连接失败');
    } finally {
      setBusy(false);
    }
  };
  const send = async (text = input) => {
    if (!text.trim() || busy) return;
    setError('');
    setInput('');
    try {
      (await ensure()).send({ type: 'text', text });
    } catch (e) {
      setError(String(e));
    }
  };
  const wake = async () => {
    setError('');
    try {
      (await ensure()).send({ type: 'wake', source: 'button' });
    } catch (e) {
      setError(String(e));
    }
  };
  const reset = () => {
    if (activeAnswer.current) discarded.current.add(activeAnswer.current);
    client.current?.send({ type: 'reset' });
    setEntries([]);
    setPartial('');
    setError('');
    setNotice('');
  };
  // 追问只对语音有意义；纯文字时不显示倒计时。
  const countdown = voice ? Math.max(0, Math.ceil((followup - now) / 1000)) : 0;
  const followupMs = config?.followupMs ?? 8000;
  const followupLeft = countdown && state === 'IDLE' ? Math.max(0, followup - now) / followupMs : 0;
  const answering = state === 'THINKING' || state === 'SPEAKING';
  const lastAssistant = [...entries].reverse().find((e) => e.role === 'assistant');
  const wakeWord = config?.wakeWord ?? '你好超宝';
  const headline =
    headlines[state] ||
    (state === 'SPEAKING'
      ? '正在为你解答'
      : countdown
        ? '还想问什么？直接说'
        : voice
          ? `说「${wakeWord}」唤醒我`
          : `我是${skins[skinId].name}，你的桌面伙伴`);
  // 舞台字幕：聆听时显示实时转写，回答时显示正在播报的内容。
  const live =
    partial ||
    (answering && lastAssistant?.text
      ? lastAssistant.text.slice(-72)
      : state === 'LISTENING'
        ? '说出你的问题，说完我会自动开始回答'
        : countdown
          ? `${countdown} 秒内可直接追问，不用再叫我`
          : voice
            ? '回答时可以直接开口打断，也可以说「别说了」'
            : config?.provider === 'demo'
              ? '当前为演示模式，可在下方输入文字体验'
              : '连接麦克风后即可语音对话，也可以直接输入文字');
  const micLevel = state === 'LISTENING' || state === 'CANDIDATE' ? (audio?.level ?? 0) : level;
  const ring = 2 * Math.PI * 31;
  const important = state !== 'IDLE' || countdown > 0 || !!partial;
  const night = theme === 'night' || (theme === 'auto' && (hour >= 19 || hour < 6));
  const pickSkin = (id: SkinId) => {
    setSkinId(id);
    try {
      localStorage.setItem(SKIN_KEY, id);
    } catch {
      /* 隐私模式下忽略 */
    }
  };
  return (
    <div
      className={`app state-${state.toLowerCase()} ${historyOpen ? 'history-open' : ''}`}
      style={{ '--level': Math.min(1, micLevel).toFixed(3) } as React.CSSProperties}
    >
      {vrm || !webgl ? (
        <Scene night={night} notes={suggestions} onNote={(text) => void send(text)}>
          {vrm ? (
            <div className="vrm-stage">
              <div className="caption">
                <h1>{headline}</h1>
                <p className={`live-text ${partial ? 'is-partial' : ''}`} aria-live="polite">
                  {live}
                </p>
              </div>
              <Avatar state={state} level={level} vrmUrl={vrm} />
            </div>
          ) : (
            <Pet
              skin={skins[skinId]}
              state={state}
              mouth={level}
              voice={voice}
              wakeWord={wakeWord}
              headline={headline}
              live={live}
              partial={!!partial}
              important={important}
              onWake={() => void wake()}
            />
          )}
        </Scene>
      ) : (
        <Pet3D
          skin={skins[skinId]}
          night={night}
          state={state}
          mouth={level}
          micLevel={audio?.level ?? 0}
          voice={voice}
          wakeWord={wakeWord}
          headline={headline}
          live={live}
          partial={!!partial}
          important={important}
          side={historyOpen && wide ? 384 : 0}
          notes={suggestions}
          onNote={(text) => void send(text)}
          onWake={() => void wake()}
        />
      )}
      <header className="topbar">
        <a className="brand" href="/" aria-label="超宝首页">
          <img src="/favicon.svg" alt="" width={32} height={32} />
          <strong>超宝</strong>
          <span>桌宠语音助手</span>
        </a>
        <div className="topbar-status">
          <span className={`status-pill ${voice ? 'online' : ''}`}>
            <i />
            {voice ? '语音已连接' : '语音未连接'}
          </span>
          <span className="mode-pill">
            {labels[state]} ·{' '}
            {config?.provider === 'demo'
              ? '演示模式'
              : config?.qaProvider === 'yuxi'
                ? 'Yuxi 问答'
                : config?.provider === 'local'
                  ? '本地模型'
                  : '百炼云端'}
          </span>
        </div>
        <div className="topbar-actions">
          <button
            className="icon-button history-toggle"
            aria-label="对话记录"
            aria-pressed={historyOpen}
            onClick={() => setHistoryOpen((v) => !v)}
          >
            <Icon name="chat" />
            {entries.length > 0 && <b>{entries.length}</b>}
          </button>
          <button className="icon-button" onClick={() => setSettings(true)} aria-label="打开设置">
            <Icon name="settings" />
          </button>
        </div>
      </header>
      {(error || notice) && (
        <div className={`toast ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>
          <span>{error || notice}</span>
          <button
            aria-label="关闭提示"
            onClick={() => {
              setError('');
              setNotice('');
            }}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
      <div className="dock">
        <button
          className={`dock-button ${voice ? 'active' : ''}`}
          onClick={connectVoice}
          disabled={busy || config?.provider === 'demo'}
          aria-label={voice ? '断开麦克风' : '连接麦克风'}
          title={voice ? '断开麦克风' : '连接麦克风'}
        >
          <Icon name={voice ? 'mic' : 'micOff'} />
          <span>{busy ? '连接中' : voice ? '麦克风开' : '连接麦克风'}</span>
        </button>
        <div className="orb-wrap">
          <svg className="orb-ring" viewBox="0 0 70 70" aria-hidden="true">
            <circle cx="35" cy="35" r="31" />
            <circle
              className="progress"
              cx="35"
              cy="35"
              r="31"
              strokeDasharray={ring}
              strokeDashoffset={ring * (1 - followupLeft)}
            />
          </svg>
          <button
            className="orb"
            onClick={wake}
            disabled={busy}
            aria-label={answering ? '打断并提问' : '点按唤醒'}
            title={answering ? '打断并提问' : '点按唤醒'}
          >
            <span className="orb-bars" aria-hidden="true">
              {[0.55, 0.85, 1, 0.85, 0.55].map((k, i) => (
                <i key={i} style={{ '--k': k } as React.CSSProperties} />
              ))}
            </span>
            <Icon name="mic" size={24} />
          </button>
        </div>
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={`和${skins[skinId].name}聊点什么…`}
            aria-label="输入消息"
            maxLength={2000}
          />
          <button aria-label="发送消息" disabled={!input.trim() || busy}>
            <Icon name="send" size={18} />
          </button>
        </form>
        <button
          className={`dock-button stop ${answering ? 'armed' : ''}`}
          onClick={() => client.current?.send({ type: 'interrupt', reason: 'stop' })}
          disabled={!connected}
          aria-label="停止回答"
          title="停止回答"
        >
          <Icon name="square" />
          <span>停止</span>
        </button>
      </div>
      <aside className="history" aria-label="对话记录面板">
        <div className="history-header">
          <h2>
            对话记录 <span>{entries.length}</span>
          </h2>
          <button className="icon-button small" aria-label="清空对话" onClick={reset}>
            <Icon name="refresh" size={16} />
          </button>
          <button
            className="icon-button small history-close"
            aria-label="收起对话记录"
            onClick={() => setHistoryOpen(false)}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="messages" ref={list}>
          {entries.length === 0 ? (
            <div className="empty-conversation">
              <h3>你好，我是超宝</h3>
              <p>想聊什么，尽管开口。也可以从这些话题开始：</p>
              <div className="suggestions">
                {suggestions.map((text) => (
                  <button onClick={() => void send(text)} key={text}>
                    {text}
                    <Icon name="arrow" size={14} />
                  </button>
                ))}
              </div>
            </div>
          ) : (
            entries.map((item) => (
              <article className={`message ${item.role}`} key={item.id}>
                <div className="message-author">
                  {item.role === 'user' ? '你' : '超宝'}
                  {item.interrupted && <small>已打断</small>}
                </div>
                <div className="message-text">
                  {item.text || (item.interrupted ? '回答已停止' : '…')}
                </div>
              </article>
            ))
          )}
          {partial && (
            <article className="message user partial">
              <div className="message-author">正在识别</div>
              <div className="message-text">{partial}</div>
            </article>
          )}
          {state === 'THINKING' && (
            <div className="thinking-dots" aria-label="思考中">
              <i />
              <i />
              <i />
            </div>
          )}
        </div>
        <p className="history-tip">回复由 AI 生成，请核实重要信息</p>
      </aside>
      {settings && (
        <div className="modal-backdrop" onClick={() => setSettings(false)}>
          <section
            className="settings-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h2 id="settings-title">桌宠与语音</h2>
              <button
                className="icon-button small"
                aria-label="关闭设置"
                onClick={() => setSettings(false)}
              >
                <Icon name="close" />
              </button>
            </div>
            <h3 className="settings-section">桌宠形象</h3>
            <div className="skin-picker" role="radiogroup" aria-label="桌宠形象">
              {Object.values(skins).map((s) => (
                <button
                  key={s.id}
                  role="radio"
                  aria-checked={!vrm && s.id === skinId}
                  className="skin-card"
                  onClick={() => {
                    pickSkin(s.id);
                    if (vrm) {
                      URL.revokeObjectURL(vrm);
                      setVrm(undefined);
                    }
                  }}
                >
                  <SkinThumb skin={s} />
                  <b>{s.name}</b>
                  <small>{s.intro}</small>
                </button>
              ))}
            </div>
            <div className="theme-picker" role="radiogroup" aria-label="场景">
              {(
                [
                  ['auto', '跟随时间'],
                  ['day', '白天'],
                  ['night', '夜晚'],
                ] as const
              ).map(([id, name]) => (
                <button
                  key={id}
                  role="radio"
                  aria-checked={theme === id}
                  onClick={() => {
                    setTheme(id);
                    try {
                      localStorage.setItem(THEME_KEY, id);
                    } catch {
                      /* 忽略 */
                    }
                  }}
                >
                  {name}
                </button>
              ))}
            </div>
            <h3 className="settings-section">语音能力</h3>
            <div className="capabilities">
              {Object.entries({
                唤醒词: wakeWord,
                唤醒应答: config?.wakeAck
                  ? `语音「${config.wakeAck.split(/[,，]/)[0]}」`
                  : '提示音',
                端侧唤醒: audio?.kws ?? (config?.assets.kws ? '已安装，连接后加载' : '未安装'),
                '端侧 VAD': audio?.vad ?? (config?.assets.vad ? '已安装，连接后加载' : '未安装'),
                降噪: audio?.noise ?? '连接后加载',
                声纹锁定:
                  audio?.speaker ?? (config?.assets.speaker ? '已安装，连接后加载' : '未安装'),
                ASR: config?.asrModel ?? '—',
                LLM: config?.llmModel ?? '—',
                TTS: config?.ttsModel ?? '—',
                首音频延迟: latency ? `${latency} ms` : '—',
              }).map(([key, value]) => (
                <div key={key}>
                  <span>{key}</span>
                  <b>{value}</b>
                </div>
              ))}
            </div>
            <label className="upload-label">
              {vrm ? '更换 VRM 形象' : '改用自己的 VRM 3D 形象'}
              <input
                type="file"
                accept=".vrm"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    if (vrm) URL.revokeObjectURL(vrm);
                    setVrm(URL.createObjectURL(file));
                  }
                }}
              />
            </label>
            <p className="settings-hint">
              桌宠会自己散步、敲电脑、喝咖啡、打盹；可以拖着它走，点它可以唤醒（未连麦克风时是摸摸头）。VRM
              仅在浏览器内读取，选回上面的桌宠形象即可恢复。
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(params.has('gallery') ? <Gallery /> : <App />);
