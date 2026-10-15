import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AssistantClient, type AppConfig } from './client';
import { Avatar } from './Avatar';
import type { AudioStatus } from './audio';
import type { AssistantState, ServerEvent } from '../../shared/protocol';
import './style.css';
const labels: Record<AssistantState, string> = {
  IDLE: '等待你的呼唤',
  CANDIDATE: '听见你的呼唤',
  LISTENING: '我在听，请说吧',
  THINKING: '让我想一想',
  SPEAKING: '正在为你解答',
  INTERRUPT: '好的，你先说',
};
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
    [settings, setSettings] = useState(false);
  const [audio, setAudio] = useState<AudioStatus>(),
    [level, setLevel] = useState(0),
    [followup, setFollowup] = useState(0),
    [now, setNow] = useState(Date.now());
  const [latency, setLatency] = useState<number>(),
    [vrm, setVrm] = useState<string>();
  const client = useRef<AssistantClient | undefined>(undefined),
    list = useRef<HTMLDivElement>(null);
  const activeAnswer = useRef<string | undefined>(undefined);
  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then(setConfig)
      .catch(() => setError('无法连接服务端，请检查 npm run dev 是否已启动。'));
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => {
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
  const ensure = async () => {
    if (client.current && connected) return client.current;
    const next = new AssistantClient(onEvent, setAudio, setLevel);
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
        setNotice('麦克风已连接。说“你好超宝”，也可以点击下方按钮开始。');
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
    client.current?.send({ type: 'reset' });
    setEntries([]);
    setPartial('');
    setError('');
    setNotice('');
  };
  const countdown = Math.max(0, Math.ceil((followup - now) / 1000));
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="超宝首页">
          <span className="brand-symbol">✦</span>
          <strong>
            超宝<span>CHAOBAO</span>
          </strong>
        </a>
        <div className="workspace-label">数字人工作空间</div>
        <div className="nav-item selected">
          <Icon name="mic" />
          <span>语音对话</span>
          <i />
        </div>
        <div className="sidebar-card">
          <span className="mini-star">✧</span>
          <h3>
            每一次呼唤
            <br />
            都有回应。
          </h3>
          <p>
            用自然的声音，
            <br />
            开启和超宝的对话。
          </p>
          <div className="small-wave">▂ ▅ ▃ ▇ ▄ ▆ ▂ ▅ ▃ ▆ ▄</div>
        </div>
        <div className="sidebar-bottom">
          <div>
            <Icon name="shield" size={16} />
            <span>纯音频交互 · 保护隐私</span>
          </div>
          <small>
            CHAOBAO ASSISTANT <span>V0.1</span>
          </small>
        </div>
      </aside>
      <main>
        <header>
          <div>
            <span className="eyebrow">YOUR VOICE, A LITTLE CLOSER</span>
            <h1>
              与超宝，自然对话<span>。</span>
            </h1>
            <p>说一句「{config?.wakeWord ?? '你好超宝'}」，让想法被听见。</p>
          </div>
          <button className="icon-button" onClick={() => setSettings(true)} aria-label="打开设置">
            <Icon name="settings" />
          </button>
        </header>
        <div className="content-grid">
          <section className="stage-panel">
            <div className="panel-top">
              <span className={`connection-badge ${voice ? 'online' : ''}`}>
                <i />
                {voice ? '语音已连接' : '语音未连接'}
              </span>
              <span className="mode-badge">
                {config?.provider === 'demo'
                  ? '本地演示'
                  : config?.provider === 'local'
                    ? '本地模型'
                    : '百炼云端'}
              </span>
            </div>
            <Avatar state={state} level={level} vrmUrl={vrm} />
            <div className="stage-caption">
              <span className="avatar-name">
                超宝 <small>你的数字伙伴</small>
              </span>
              <h2>{countdown && state === 'IDLE' ? '还想聊点什么？' : labels[state]}</h2>
              <p>
                {countdown && state === 'IDLE'
                  ? `可继续追问 · ${countdown}s${audio?.speaker === '目标说话人已锁定' ? '' : ' · 请点按开始'}`
                  : voice
                    ? '随时呼唤，也可以随时打断'
                    : '连接麦克风，开启语音对话'}
              </p>
              <div
                className={`sound-wave ${state === 'SPEAKING' || state === 'LISTENING' ? 'active' : ''}`}
              >
                {Array.from({ length: 27 }, (_, i) => (
                  <i
                    key={i}
                    style={{
                      height: `${5 + Math.sin(i * 1.7) ** 2 * (state === 'LISTENING' ? (audio?.level ?? 0) * 35 : level * 35 + 5)}px`,
                      animationDelay: `${i * 50}ms`,
                    }}
                  />
                ))}
              </div>
            </div>
            <div className="voice-actions">
              <button
                className={`primary-button ${voice ? 'connected-button' : ''}`}
                onClick={connectVoice}
                disabled={busy || config?.provider === 'demo'}
              >
                <Icon name="mic" />
                {busy ? '正在连接…' : voice ? '断开麦克风' : '连接麦克风'}
              </button>
              <button className="secondary-button" onClick={wake} disabled={busy}>
                点按唤醒
                <Icon name="arrow" size={16} />
              </button>
              <button
                className="icon-button interrupt"
                onClick={() => client.current?.send({ type: 'interrupt', reason: 'stop' })}
                disabled={!connected}
                aria-label="停止回答"
              >
                <Icon name="stop" />
              </button>
            </div>
            <div className="stage-footer">
              <span>
                <i />
                回声消除 AEC
              </span>
              <span>
                <i />
                本地唤醒
              </span>
              <span>
                <i />
                随时打断
              </span>
            </div>
          </section>
          <section className="conversation-panel">
            <div className="conversation-header">
              <h2>
                对话记录 <span>{entries.length.toString().padStart(2, '0')}</span>
              </h2>
              <button className="icon-button" aria-label="清空对话" onClick={reset}>
                <Icon name="refresh" size={17} />
              </button>
            </div>
            <div className="messages" ref={list}>
              {entries.length === 0 ? (
                <div className="empty-conversation">
                  <div className="empty-mark">✳</div>
                  <h3>你好，我是超宝</h3>
                  <p>
                    想聊什么，尽管开口。
                    <br />
                    也可以从这些话题开始。
                  </p>
                  <div className="suggestions">
                    {['介绍一下你自己', '帮我整理今天的工作思路', '如何在回答时打断你？'].map(
                      (text) => (
                        <button onClick={() => void send(text)} key={text}>
                          {text}
                          <Icon name="arrow" size={14} />
                        </button>
                      ),
                    )}
                  </div>
                </div>
              ) : (
                entries.map((item) => (
                  <article className={`message ${item.role}`} key={item.id}>
                    <div className="message-author">
                      {item.role === 'user' ? '你' : '✦ 超宝'}
                      <small>{item.interrupted ? '已打断' : ''}</small>
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
                  <div className="message-text">
                    {partial}
                    <span className="typing-cursor" />
                  </div>
                </article>
              )}
              {state === 'THINKING' && (
                <div className="thinking-dots">
                  <i />
                  <i />
                  <i />
                </div>
              )}
            </div>
            {(error || notice) && (
              <div className={`notice ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>
                {error || notice}
                <button
                  aria-label="关闭提示"
                  onClick={() => {
                    setError('');
                    setNotice('');
                  }}
                >
                  ×
                </button>
              </div>
            )}
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
                placeholder="或在这里输入你想说的话…"
                aria-label="输入消息"
                maxLength={2000}
              />
              <button aria-label="发送消息" disabled={!input.trim() || busy}>
                <Icon name="send" size={19} />
              </button>
            </form>
            <div className="composer-tip">
              Enter 发送 <span>回复由 AI 生成，请核实重要信息</span>
            </div>
          </section>
        </div>
        <footer className="status-strip">
          <span className="status-label">
            <i className={voice ? 'live' : ''} />
            {voice ? '系统运行中' : '等待连接'}
          </span>
          <span>
            唤醒词 <b>{config?.wakeWord ?? '你好超宝'}</b>
          </span>
          <span>
            语音识别 <b>{config?.provider === 'demo' ? '演示模式' : 'Paraformer'}</b>
          </span>
          <span>
            语音合成 <b>CosyVoice</b>
          </span>
          <span className="latency">
            首音频 <b>{latency ? `${latency} ms` : '—'}</b>
          </span>
        </footer>
      </main>
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
              <h2 id="settings-title">语音与形象</h2>
              <button
                className="icon-button"
                aria-label="关闭设置"
                onClick={() => setSettings(false)}
              >
                <Icon name="close" />
              </button>
            </div>
            <p>
              唤醒词：<strong>{config?.wakeWord}</strong>
            </p>
            <div className="capabilities">
              {Object.entries({
                端侧唤醒: audio?.kws ?? (config?.assets.kws ? '已安装，连接后加载' : '未安装'),
                '端侧 VAD': audio?.vad ?? (config?.assets.vad ? '已安装，连接后加载' : '未安装'),
                降噪: audio?.noise ?? '连接后加载',
                声纹锁定:
                  audio?.speaker ?? (config?.assets.speaker ? '已安装，连接后加载' : '未安装'),
                ASR: config?.asrModel ?? '—',
                LLM: config?.llmModel ?? '—',
                TTS: config?.ttsModel ?? '—',
              }).map(([key, value]) => (
                <div key={key}>
                  <span>{key}</span>
                  <b>{value}</b>
                </div>
              ))}
            </div>
            <label className="upload-label">
              导入自己的 VRM 形象
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
              VRM
              仅在浏览器内读取。未锁定声纹时，连续对话和免唤醒打断需要点按；口型目前按音频能量驱动，字级时间戳为估算。
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
