import { afterEach, describe, expect, it, vi } from 'vitest';
import { Conversation } from '../server/engine';
import type { Providers, Transcript } from '../server/providers/types';
import type { ServerEvent } from '../shared/protocol';
import { SemanticPolicy } from '../server/semantic';
const active: Conversation[] = [];
afterEach(() => {
  active.forEach((c) => c.close());
  active.length = 0;
  vi.useRealTimers();
});
function harness(
  llm?: Providers['llm'],
  audio = false,
  options: Partial<ConstructorParameters<typeof Conversation>[2]> = {},
  tts?: Providers['tts'],
  asr?: Providers['asr'],
) {
  const events: ServerEvent[] = [];
  let result: ((r: Transcript) => void) | undefined;
  let aborted = false;
  const p: Providers = {
    demo: false,
    asr: asr ?? {
      async open(onResult, _error, signal) {
        result = onResult;
        signal.addEventListener('abort', () => (aborted = true));
        return { write() {}, finish() {}, close() {} };
      },
    },
    llm: llm ?? {
      async *chat() {
        yield '你好。';
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
    audio ? { async write() {}, async drain() {}, clear() {} } : undefined,
  );
  active.push(c);
  return { c, events, result: (r: Transcript) => result?.(r), aborted: () => aborted };
}
const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
};
describe('真实会话编排', () => {
  it('旧追问的 ASR 握手延迟失败不能中断新的回答', async () => {
    let rejectOpen: (error: Error) => void = () => {};
    let releaseAnswer: () => void = () => {};
    const hold = new Promise<void>((resolve) => (releaseAnswer = resolve));
    let answerSignal: AbortSignal | undefined;
    const { c, events } = harness(
      {
        async *chat(messages, signal) {
          if (messages.at(-1)?.content === '新问题') {
            answerSignal = signal;
            await hold;
            signal.throwIfAborted();
          }
          yield '有效回答。';
        },
      },
      false,
      {},
      undefined,
      {
        open() {
          return new Promise((_resolve, reject) => (rejectOpen = reject));
        },
      },
    );
    c.handle({ type: 'text', text: '第一个问题' });
    await flush();
    c.handle({ type: 'vad', speaking: true, target: false });
    c.handle({ type: 'text', text: '新问题' });
    await flush();
    rejectOpen(new Error('百炼语音连接失败，请检查网络、地域和密钥。'));
    await flush();
    const aborted = answerSignal?.aborted;
    releaseAnswer();
    await flush();
    expect(aborted).toBe(false);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(2);
    expect(c.history.at(-1)?.content).toBe('有效回答。');
  });

  it('旧 TTS 延迟报错不能取消新的回答', async () => {
    const { c, events } = harness(
      {
        async *chat(messages, signal) {
          const text = messages.at(-1)!.content;
          if (text === '新问题') await new Promise((r) => setTimeout(r, 120));
          signal.throwIfAborted();
          yield text === '旧问题' ? '旧回答。' : '新回答。';
        },
      },
      true,
      {},
      {
        async *synth(text, signal) {
          if (text.includes('旧'))
            await new Promise((_, reject) =>
              signal.addEventListener(
                'abort',
                () => setTimeout(() => reject(new Error('旧请求取消')), 40),
                { once: true },
              ),
            );
          else yield Buffer.alloc(960);
        },
      },
    );
    c.handle({ type: 'text', text: '旧问题' });
    await flush();
    c.handle({ type: 'text', text: '新问题' });
    await new Promise((r) => setTimeout(r, 250));
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(c.history.at(-1)?.content).toBe('新回答。');
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });
  it('清空后不把中断前的助手内容带回新会话', async () => {
    let release: () => void = () => {};
    const wait = new Promise<void>((r) => (release = r));
    const { c, events } = harness(
      {
        async *chat(messages) {
          yield messages.at(-1)?.content === '旧问题' ? '旧回答。' : '新回答。';
          if (messages.at(-1)?.content === '旧问题') await wait;
        },
      },
      true,
    );
    c.handle({ type: 'text', text: '旧问题' });
    await flush();
    const old = events.find((e) => e.type === 'delta');
    if (old?.type === 'delta') c.handle({ type: 'playback', turnId: old.turnId, heardChars: 2 });
    c.handle({ type: 'reset' });
    await flush();
    release();
    c.handle({ type: 'text', text: '新问题' });
    await flush();
    expect(c.history).toEqual([
      { role: 'user', content: '新问题' },
      { role: 'assistant', content: '新回答。' },
    ]);
  });
  it('文字流式回答按句合成并进入追问窗口', async () => {
    const { c, events } = harness(undefined, true);
    c.handle({ type: 'text', text: '你好' });
    await flush();
    expect(c.history).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好。' },
    ]);
    expect(events.some((e) => e.type === 'utterance')).toBe(true);
    expect(events.filter((e) => e.type === 'transcript')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'state', state: 'IDLE' });
  });
  it('唤醒复核失败不调用 LLM', async () => {
    const chat = vi.fn(async function* () {
      yield '错误回答';
    });
    const { c, result, events } = harness({ chat });
    c.handle({ type: 'wake', source: 'kws' });
    await flush();
    result({ text: '你好宝宝', final: true });
    await flush();
    expect(chat).not.toHaveBeenCalled();
    expect(c.state).toBe('CANDIDATE');
    expect(events.some((e) => e.type === 'delta')).toBe(false);
  });
  it('唤醒后带命令只把命令送入上下文', async () => {
    const { c, result } = harness();
    c.handle({ type: 'wake', source: 'kws' });
    await flush();
    result({ text: '你好，超宝，介绍一下自己。', final: true });
    await new Promise((resolve) => setTimeout(resolve, 520));
    expect(c.history[0]).toEqual({ role: 'user', content: '介绍一下自己。' });
  });
  it('播报打断取消请求且只保留听到的文字', async () => {
    let finish: () => void = () => {};
    const wait = new Promise<void>((r) => (finish = r));
    let signal: AbortSignal | undefined;
    const { c, events } = harness(
      {
        async *chat(_messages, s) {
          signal = s;
          yield '这是第一句话。';
          await wait;
          if (!s.aborted) yield '这是第二句话。';
        },
      },
      true,
    );
    c.handle({ type: 'text', text: '说两句话' });
    await flush();
    const delta = events.find((e) => e.type === 'delta');
    expect(delta?.type).toBe('delta');
    c.handle({
      type: 'playback',
      turnId: delta!.type === 'delta' ? delta!.turnId : '',
      heardChars: 2,
    });
    c.handle({ type: 'interrupt', reason: 'stop' });
    finish();
    await flush();
    expect(signal?.aborted).toBe(true);
    expect(c.history).toEqual([
      { role: 'user', content: '说两句话' },
      { role: 'assistant', content: '这是' },
    ]);
    expect(c.state).toBe('IDLE');
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });
  it('未锁定说话人不能免唤醒打断', async () => {
    const { c } = harness();
    c.state = 'SPEAKING';
    c.handle({ type: 'vad', speaking: true, target: false });
    expect(c.state).toBe('SPEAKING');
  });
  it('断句不会在 VAD 仍检测到说话时抢答', async () => {
    const chat = vi.fn(async function* () {
      yield '你好。';
    });
    const { c, result } = harness({ chat });
    c.handle({ type: 'wake', source: 'button' });
    await flush();
    c.handle({ type: 'vad', speaking: true, target: false });
    result({ text: '我还没说完', final: false });
    await new Promise((resolve) => setTimeout(resolve, 520));
    expect(chat).not.toHaveBeenCalled();
    c.handle({ type: 'vad', speaking: false, target: false });
    // 一直没有句末 final：450ms 断句 + 最多 900ms 等句尾后仍按已有文字回答
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(chat).toHaveBeenCalledOnce();
  });
  it('VAD 判停后句末 final 晚到，问题不丢句尾', async () => {
    const chat = vi.fn(async function* () {
      yield '我是超宝。';
    });
    const { c, result, events } = harness({ chat });
    c.handle({ type: 'wake', source: 'button' });
    await flush();
    c.handle({ type: 'vad', speaking: true, target: false });
    result({ text: '你是', final: false });
    c.handle({ type: 'vad', speaking: false, target: false });
    // final 晚于 450ms 断句到达（ASR 断句静音 + 链路延迟）
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(chat).not.toHaveBeenCalled();
    result({ text: '你是谁？', final: true });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(chat).toHaveBeenCalledOnce();
    expect(events.find((e) => e.type === 'transcript' && e.final)).toMatchObject({
      text: '你是谁？',
    });
    expect(c.history.find((m) => m.role === 'user')?.content).toBe('你是谁？');
  });
  it('投机请求在确认断句后复用，不重复调用 LLM', async () => {
    const chat = vi.fn(async function* () {
      yield '有效回答。';
    });
    const { c, result } = harness({ chat }, false, { speculative: true });
    c.handle({ type: 'wake', source: 'button' });
    await flush();
    result({ text: '完整问题。', final: true });
    await new Promise((r) => setTimeout(r, 520));
    expect(chat).toHaveBeenCalledOnce();
    expect(c.history.at(-1)?.content).toBe('有效回答。');
  });
  it('继续说话立即丢弃投机内容，不输出旧回答', async () => {
    const signals: AbortSignal[] = [];
    const { c, result, events } = harness(
      {
        async *chat(messages, signal) {
          signals.push(signal);
          yield `回答${messages.at(-1)?.content}。`;
        },
      },
      false,
      { speculative: true },
    );
    c.handle({ type: 'wake', source: 'button' });
    await flush();
    result({ text: '第一部分', final: false });
    await new Promise((r) => setTimeout(r, 250));
    expect(events.some((e) => e.type === 'delta')).toBe(false);
    c.handle({ type: 'vad', speaking: true, target: false });
    expect(signals[0]?.aborted).toBe(true);
    result({ text: '完整的新问题。', final: true });
    c.handle({ type: 'vad', speaking: false, target: false });
    await new Promise((r) => setTimeout(r, 520));
    expect(
      events
        .filter((e) => e.type === 'delta')
        .map((e) => (e.type === 'delta' ? e.text : ''))
        .join(''),
    ).toBe('回答完整的新问题。。');
  });
  it('过时的语义断句结果不能在恢复说话后抢答', async () => {
    let resolve: (v: boolean) => void = () => {};
    const semantic = new SemanticPolicy({
      async *chat() {
        yield '1';
      },
    });
    vi.spyOn(semantic, 'complete').mockImplementation(() => new Promise((r) => (resolve = r)));
    const chat = vi.fn(async function* () {
      yield '不该输出';
    });
    const { c, result } = harness({ chat }, false, { semantic });
    c.handle({ type: 'wake', source: 'button' });
    await flush();
    result({ text: '还没说完', final: false });
    await new Promise((r) => setTimeout(r, 250));
    c.handle({ type: 'vad', speaking: true, target: false });
    resolve(true);
    await flush();
    expect(chat).not.toHaveBeenCalled();
  });
  it('非目标说话人转写不能触发回答', async () => {
    const chat = vi.fn(async function* () {
      yield '错误响应';
    });
    const { c, result } = harness({ chat });
    c.handle({ type: 'wake', source: 'button' });
    await flush();
    c.handle({ type: 'speaker', locked: true, match: false });
    result({ text: '旁人的问题。', final: true });
    // 整句声纹足够长且明显不像本人
    c.handle({
      type: 'speaker',
      locked: true,
      match: false,
      final: true,
      score: 0.1,
      speechMs: 2000,
    });
    await new Promise((r) => setTimeout(r, 900));
    expect(chat).not.toHaveBeenCalled();
  });
});

describe('宿主流式回答', () => {
  it('只请求一次宿主问答，未结束就开始合成，并按顺序播完', async () => {
    const llm = {
      chat: vi.fn(async function* () {
        yield '不应调用';
      }),
    };
    const synthesized: string[] = [];
    const { c, events } = harness(
      llm,
      true,
      { external: true },
      {
        async *synth(text) {
          synthesized.push(text);
          yield Buffer.alloc(960);
        },
      },
    );
    c.handle({ type: 'text', text: '业务问题' });
    await flush();
    const question = events.find((e) => e.type === 'question');
    expect(question?.type).toBe('question');
    if (question?.type !== 'question') throw new Error('缺少宿主事件');
    c.handle({ type: 'host-answer', turnId: question.turnId, text: '第一句话。' });
    await flush();
    expect(synthesized).toEqual(['第一句话。']);
    expect(events.some((e) => e.type === 'done')).toBe(false);
    c.handle({ type: 'host-answer', turnId: question.turnId, text: '第二句话。', done: true });
    await flush();
    expect(synthesized).toEqual(['第一句话。', '第二句话。']);
    expect(events.find((e) => e.type === 'done')).toMatchObject({ text: '第一句话。第二句话。' });
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it('暂停后丢弃旧增量，新一轮不串音、不重复问答', async () => {
    const synthesized: string[] = [];
    const { c, events } = harness(
      undefined,
      true,
      { external: true },
      {
        async *synth(text) {
          synthesized.push(text);
          yield Buffer.alloc(960);
        },
      },
    );
    c.handle({ type: 'text', text: '旧问题' });
    await flush();
    const old = events.find((e) => e.type === 'question');
    if (old?.type !== 'question') throw new Error('缺少宿主事件');
    c.handle({ type: 'interrupt', reason: 'pause' });
    c.handle({ type: 'host-answer', turnId: old.turnId, text: '不能播放。', done: true });
    c.handle({ type: 'text', text: '新问题' });
    await flush();
    const next = events.filter((e) => e.type === 'question').at(-1);
    if (next?.type !== 'question') throw new Error('缺少新问题');
    c.handle({ type: 'host-answer', turnId: old.turnId, text: '不能串入新回答。' });
    c.handle({ type: 'host-answer', turnId: next.turnId, text: '新回答。', done: true });
    await flush();
    expect(synthesized).toEqual(['新回答。']);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
  });
});
