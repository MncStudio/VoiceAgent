import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { Conversation } from '../server/engine';
import { hasWake, isEcho, nextSegment, stripWake } from '../server/audio';
import { FunASR } from '../server/providers/local';
import { DashScopeTTS } from '../server/providers/dashscope';
import { SemanticPolicy } from '../server/semantic';
import type { Providers, Transcript } from '../server/providers/types';
import type { ServerEvent } from '../shared/protocol';
const active: Conversation[] = [];
afterEach(() => {
  active.forEach((c) => c.close());
  active.length = 0;
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
function harness(
  options: Partial<ConstructorParameters<typeof Conversation>[2]> = {},
  llm?: Providers['llm'],
  tts?: Providers['tts'],
) {
  const events: ServerEvent[] = [];
  const played: number[] = [];
  const opened: { result: (r: Transcript) => void; written: number; closed: boolean }[] = [];
  const p: Providers = {
    demo: false,
    asr: {
      async open(onResult) {
        const entry = { result: onResult, written: 0, closed: false };
        opened.push(entry);
        return {
          write(pcm) {
            entry.written += pcm.length;
          },
          finish() {},
          close() {
            entry.closed = true;
          },
        };
      },
    },
    llm: llm ?? {
      async *chat() {
        yield '好的。';
      },
    },
    tts: tts ?? {
      async *synth() {
        yield Buffer.alloc(960);
      },
    },
  };
  const c = new Conversation(
    p,
    (e) => events.push(e),
    { wakeWord: '你好超宝', followupMs: 8000, ...options },
    {
      async write(pcm) {
        played.push(pcm.length);
      },
      async drain() {},
      clear() {},
    },
  );
  active.push(c);
  return { c, events, opened, played };
}
describe('唤醒词拼音匹配', () => {
  it('同音 / 近音字也能通过复核', () => {
    for (const text of ['你好超宝', '你好，潮宝。', '你好朝保', '李好超宝', '你好超宝介绍一下'])
      expect(hasWake(text, '你好超宝')).toBe(true);
  });
  it('不同音节不能通过复核', () => {
    for (const text of ['你好宝宝', '你好', '超宝你好', '你好小宝'])
      expect(hasWake(text, '你好超宝')).toBe(false);
  });
  it('本地唤醒已命中时，复核容忍一个音节听错或漏字', () => {
    for (const text of ['我好超宝', '你要超宝', '好超宝', '你超宝，几点了'])
      expect(hasWake(text, '你好超宝', true)).toBe(true);
    for (const text of ['我好超宝', '好超宝']) expect(hasWake(text, '你好超宝')).toBe(false);
  });
  it('宽松复核仍要求“超宝”两个音节完全对上', () => {
    for (const text of ['超宝', '你好宝宝', '超宝你好', '你好小宝', '我想超市'])
      expect(hasWake(text, '你好超宝', true)).toBe(false);
  });
  it('去唤醒词也能处理听错一个字的情况', () => {
    expect(stripWake('好超宝，明天会下雨吗', '你好超宝')).toBe('明天会下雨吗');
    expect(stripWake('我好超宝介绍一下', '你好超宝')).toBe('介绍一下');
  });
  it('按拼音定位并去掉唤醒词', () => {
    expect(stripWake('你好潮宝，明天会下雨吗', '你好超宝')).toBe('明天会下雨吗');
  });
});
describe('回声与分句', () => {
  it('识别出正在播报内容的回声', () => {
    expect(isEcho('今天天气晴', '今天天气晴朗，适合出门。')).toBe(true);
    expect(isEcho('帮我查一下快递', '今天天气晴朗，适合出门。')).toBe(false);
  });
  it('首段遇到逗号尽早切出，之后按整句切', () => {
    // 逗号前不足 6 个字时不切，避免首段过碎
    expect(nextSegment('好的，我来帮你查一下', true)).toBeUndefined();
    expect(nextSegment('今天北京晴转多云，最高气温', true)).toBe('今天北京晴转多云，');
    expect(nextSegment('今天北京晴转多云，最高气温', false)).toBeUndefined();
    expect(nextSegment('好的。接下来', true)).toBe('好的。');
  });
});
describe('打断、追问与播报体验', () => {
  it('免唤醒打断确认后沿用同一识别流，不重开连接也不重复文字', async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((r) => (release = r));
    const { c, events, opened } = harness(
      {},
      {
        async *chat(_m, signal) {
          yield '这是一段比较长的回答。';
          await hold;
          signal.throwIfAborted();
        },
      },
    );
    c.handle({ type: 'text', text: '讲个故事' });
    await wait(20);
    expect(c.state).toBe('SPEAKING');
    c.handle({ type: 'speaker', locked: true, match: true });
    c.handle({ type: 'vad', speaking: true, target: true });
    await wait(20);
    expect(opened).toHaveLength(1);
    opened[0].result({ text: '帮我查一下天气', final: true });
    await wait(20);
    expect(c.state).toBe('LISTENING');
    expect(events.some((e) => e.type === 'interrupted')).toBe(true);
    expect(opened).toHaveLength(1);
    expect(opened[0].closed).toBe(false);
    c.handle({ type: 'vad', speaking: false, target: true });
    await wait(520);
    // 打断时还没播出任何字，不写入助手回复；新问题只出现一次
    expect(c.history.at(-1)).toEqual({ role: 'user', content: '帮我查一下天气' });
    expect(c.history.filter((m) => m.content === '帮我查一下天气')).toHaveLength(1);
    expect(opened).toHaveLength(1);
    release();
  });
  it('播报内容的回声不会被当成打断', async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((r) => (release = r));
    const { c, opened } = harness(
      {},
      {
        async *chat(_m, signal) {
          yield '今天天气晴朗，适合出门。';
          await hold;
          signal.throwIfAborted();
        },
      },
    );
    c.handle({ type: 'text', text: '天气' });
    await wait(20);
    c.handle({ type: 'speaker', locked: true, match: true });
    c.handle({ type: 'vad', speaking: true, target: true });
    await wait(20);
    opened[0].result({ text: '今天天气晴朗', final: false });
    await wait(20);
    expect(c.state).toBe('SPEAKING');
    release();
  });
  it('追问时回放从开口前开始，不截掉句首', async () => {
    const { c, opened } = harness();
    c.handle({ type: 'text', text: '你好' });
    await wait(30);
    c.handle({ type: 'speaker', locked: true, match: true });
    for (let i = 0; i < 100; i++) c.ingest(Buffer.alloc(640)); // 2 秒音频
    // 已锁定声纹也不等声纹确认，开口即开始识别
    c.handle({ type: 'vad', speaking: true, target: false });
    await wait(20);
    expect(c.state).toBe('LISTENING');
    // 至少回放 0.7s，覆盖 VAD 的 300ms 前置判定和句首
    expect(opened[0].written).toBeGreaterThanOrEqual(0.7 * 32000);
  });
  it('未锁定声纹时也能免唤醒追问', async () => {
    const { c } = harness();
    c.handle({ type: 'text', text: '你好' });
    await wait(30);
    c.handle({ type: 'vad', speaking: true, target: false });
    await wait(20);
    expect(c.state).toBe('LISTENING');
  });
  it('追问判断超时默认作答，不再要求点按', async () => {
    const semantic = new SemanticPolicy({
      async *chat() {
        yield '1';
      },
    });
    vi.spyOn(semantic, 'complete').mockResolvedValue(true);
    vi.spyOn(semantic, 'directed').mockRejectedValue(new Error('timeout'));
    const chat = vi.fn(async function* () {
      yield '好的。';
    });
    const { c, opened } = harness({ semantic }, { chat });
    c.handle({ type: 'text', text: '你好' });
    await wait(30);
    c.handle({ type: 'vad', speaking: true, target: false });
    await wait(20);
    opened[0].result({ text: '那明天呢', final: true });
    c.handle({ type: 'vad', speaking: false, target: false });
    await wait(400);
    expect(chat).toHaveBeenCalledTimes(2);
  });
  it('下一句在上一句播放时已开始合成', async () => {
    const started: string[] = [];
    let playing: () => void = () => {};
    const firstPlayed = new Promise<void>((r) => (playing = r));
    const events: ServerEvent[] = [];
    const c = new Conversation(
      {
        demo: false,
        asr: {
          async open() {
            return { write() {}, finish() {}, close() {} };
          },
        },
        llm: {
          async *chat() {
            yield '第一句话。第二句话。';
          },
        },
        tts: {
          async *synth(text) {
            started.push(text);
            yield Buffer.alloc(960);
          },
        },
      },
      (e) => events.push(e),
      { wakeWord: '你好超宝', followupMs: 8000 },
      {
        async write() {
          // 第一句播放被“卡住”，期间第二句应已开始合成。
          if (started.length && !events.some((e) => e.type === 'alignment')) await firstPlayed;
        },
        async drain() {},
        clear() {},
      },
    );
    active.push(c);
    c.handle({ type: 'text', text: '说两句' });
    await wait(30);
    expect(started).toEqual(['第一句话。', '第二句话。']);
    playing();
    await wait(30);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });
});
describe('本地 FunASR 结果归一', () => {
  it('2pass-online 增量片段累加，2pass-offline 整句替换并结束', async () => {
    const server = new WebSocketServer({ port: 0 });
    const port = await new Promise<number>((r) =>
      server.on('listening', () => r((server.address() as { port: number }).port)),
    );
    server.on('connection', (ws) => {
      ws.once('message', () => {
        ws.send(JSON.stringify({ mode: '2pass-online', text: '你好' }));
        ws.send(JSON.stringify({ mode: '2pass-online', text: '超宝' }));
        ws.send(JSON.stringify({ mode: '2pass-offline', text: '你好，超宝。' }));
      });
    });
    const results: Transcript[] = [];
    const asr = new FunASR(`ws://127.0.0.1:${port}`, { 超宝: 20 });
    const stream = await asr.open(
      (r) => results.push(r),
      () => {},
      new AbortController().signal,
    );
    await wait(100);
    stream.close();
    server.close();
    expect(results).toEqual([
      { text: '你好', final: false },
      { text: '你好超宝', final: false },
      { text: '你好，超宝。', final: true },
    ]);
  });
});
describe('追问灵敏度', () => {
  it('已锁定声纹时短句追问不等声纹，直接识别并作答', async () => {
    const { c, opened, events } = harness();
    c.handle({ type: 'text', text: '今天天气' });
    await wait(30);
    c.handle({ type: 'speaker', locked: true, match: true });
    c.handle({ type: 'vad', speaking: true, target: false });
    await wait(20);
    expect(c.state).toBe('LISTENING');
    opened[0].result({ text: '那明天呢', final: true });
    c.handle({ type: 'vad', speaking: false, target: false });
    // 短句声纹分数不可靠：不拒绝
    c.handle({
      type: 'speaker',
      locked: true,
      match: false,
      final: true,
      score: 0.3,
      speechMs: 600,
    });
    await wait(1000);
    expect(c.history.some((m) => m.role === 'user' && m.content === '那明天呢')).toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });
  it('明显是他人的长句追问被忽略，但追问窗口保留', async () => {
    const { c, opened, events } = harness();
    c.handle({ type: 'text', text: '今天天气' });
    await wait(30);
    c.handle({ type: 'speaker', locked: true, match: true });
    c.handle({ type: 'vad', speaking: true, target: false });
    await wait(20);
    opened[0].result({ text: '妈你看到我的钥匙了吗', final: true });
    c.handle({ type: 'vad', speaking: false, target: false });
    c.handle({
      type: 'speaker',
      locked: true,
      match: false,
      final: true,
      score: 0.1,
      speechMs: 2000,
    });
    await wait(1000);
    expect(c.history.some((m) => m.content === '妈你看到我的钥匙了吗')).toBe(false);
    expect(c.state).toBe('IDLE');
    const last = events.filter((e) => e.type === 'state').at(-1) as { followupUntil?: number };
    expect(last.followupUntil ?? 0).toBeGreaterThan(Date.now());
    // 本人随后追问仍然生效
    c.handle({ type: 'vad', speaking: true, target: false });
    await wait(20);
    expect(c.state).toBe('LISTENING');
  });
  it('FOLLOWUP_MS=0（默认）时回答后不能免唤醒追问', async () => {
    const { c, events } = harness({ followupMs: 0 });
    c.handle({ type: 'text', text: '你好' });
    await wait(250);
    const last = events.filter((e) => e.type === 'state').at(-1) as { followupUntil?: number };
    expect(c.state).toBe('IDLE');
    expect(last.followupUntil ?? 0).toBe(0);
    c.handle({ type: 'vad', speaking: true, target: false });
    await wait(50);
    expect(c.state).toBe('IDLE');
  });
  it('追问窗口到期时正在说的话不会被丢弃', async () => {
    const { c, opened } = harness({ followupMs: 300 });
    c.handle({ type: 'text', text: '你好' });
    await wait(250);
    c.handle({ type: 'vad', speaking: true, target: false });
    await wait(200); // 窗口已过期，用户还在说
    opened[0].result({ text: '再讲一个笑话吧', final: true });
    c.handle({ type: 'vad', speaking: false, target: false });
    await wait(800);
    expect(c.history.some((m) => m.content === '再讲一个笑话吧')).toBe(true);
  });
  it('播报结束后的残余回声不会被当成追问', async () => {
    const { c, opened } = harness(
      {},
      {
        async *chat() {
          yield '今天北京晴朗，适合出门。';
        },
      },
    );
    c.handle({ type: 'text', text: '天气' });
    await wait(30);
    c.handle({ type: 'vad', speaking: true, target: false });
    await wait(20);
    opened[0].result({ text: '适合出门', final: true });
    c.handle({ type: 'vad', speaking: false, target: false });
    await wait(800);
    expect(c.history.filter((m) => m.role === 'user')).toHaveLength(1);
  });
});
describe('唤醒应答', () => {
  const wakeOnly = async (text: string, opts = {}) => {
    const h = harness({ wakeAck: ['我在'], ...opts });
    h.c.handle({ type: 'wake', source: 'kws' });
    await wait(20);
    h.opened[0].result({ text, final: false });
    return h;
  };
  it('只说唤醒词时先应答“我在”，不播提示音', async () => {
    const { events, played } = await wakeOnly('你好超宝');
    expect(events.find((e) => e.type === 'wake-confirmed')).toMatchObject({ chime: false });
    await wait(400);
    expect(events.some((e) => e.type === 'ack' && e.text === '我在')).toBe(true);
    expect(played.length).toBeGreaterThan(0);
  });
  it('唤醒词后直接说命令（一句话直达）也先应答“我在”，再回答', async () => {
    const { events, c, opened } = await wakeOnly('你好超宝明天天气怎么样');
    opened[0].result({ text: '你好超宝明天天气怎么样', final: true });
    await wait(1200);
    const ack = events.findIndex((e) => e.type === 'ack' && e.text === '我在');
    expect(ack).toBeGreaterThanOrEqual(0);
    expect(c.history.find((m) => m.role === 'user')?.content).toBe('明天天气怎么样');
    // 回答在应答之后开始
    expect(events.findIndex((e) => e.type === 'state' && e.state === 'THINKING')).toBeGreaterThan(
      ack,
    );
  });
  it('唤醒后用户接着说，等说完再应答', async () => {
    const { c, events } = await wakeOnly('你好超宝');
    c.handle({ type: 'vad', speaking: true, target: false });
    await wait(400);
    expect(events.some((e) => e.type === 'ack')).toBe(false);
    c.handle({ type: 'vad', speaking: false, target: false });
    await wait(400);
    expect(events.some((e) => e.type === 'ack')).toBe(true);
  });
  it('点按唤醒也先应答“我在”', async () => {
    const h = harness({ wakeAck: ['我在'] });
    h.c.handle({ type: 'wake', source: 'button' });
    await wait(400);
    expect(h.events.some((e) => e.type === 'ack' && e.text === '我在')).toBe(true);
  });
  it('应答的回声不会混进用户的话', async () => {
    const { c, opened } = await wakeOnly('你好超宝');
    await wait(400);
    opened[0].result({ text: '你好超宝。我在，帮我查一下快递', final: true });
    await wait(700);
    expect(c.history.find((m) => m.role === 'user')?.content).toBe('帮我查一下快递');
  });
  it('未配置应答时改用提示音', async () => {
    const { events } = await wakeOnly('你好超宝', { wakeAck: [] });
    await wait(400);
    expect(events.find((e) => e.type === 'wake-confirmed')).toMatchObject({ chime: true });
    expect(events.some((e) => e.type === 'ack')).toBe(false);
  });
});
describe('百炼 TTS 预热连接', () => {
  it('预热连接被服务端判为空闲超时（InvalidParameter）时，换新连接重试且不报错', async () => {
    const server = new WebSocketServer({ port: 0 });
    let connections = 0;
    server.on('connection', (ws) => {
      const index = ++connections;
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        const id = msg.header.task_id;
        if (msg.header.action === 'run-task') {
          if (index === 1)
            ws.send(
              JSON.stringify({
                header: {
                  event: 'task-failed',
                  task_id: id,
                  error_code: 'InvalidParameter',
                  error_message: 'request timeout after 23 seconds.',
                },
              }),
            );
          else ws.send(JSON.stringify({ header: { event: 'task-started', task_id: id } }));
        } else if (msg.header.action === 'finish-task') {
          ws.send(Buffer.alloc(960));
          ws.send(JSON.stringify({ header: { event: 'task-finished', task_id: id } }));
        }
      });
    });
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as { port: number }).port;
    const tts = new DashScopeTTS(`ws://127.0.0.1:${port}`, 'k', 'cosyvoice-v2', 'v');
    tts.warm();
    await wait(50);
    let bytes = 0;
    for await (const pcm of tts.synth('你好。', new AbortController().signal)) bytes += pcm.length;
    expect(bytes).toBe(960);
    expect(connections).toBeGreaterThanOrEqual(2);
    tts.close();
    server.close();
  });
});
