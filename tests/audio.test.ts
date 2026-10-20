import { describe, expect, it } from 'vitest';
import {
  AudioRing,
  stripWake,
  isBackchannel,
  incomplete,
  incompleteLevel,
  estimatedMarks,
  kwsTokens,
} from '../server/audio';
import { clientEventSchema } from '../shared/protocol';
describe('唤醒词拼音 token', () => {
  it('默认唤醒词与原内置关键词一致（含“你好”变调）', () => {
    expect(kwsTokens('你好超宝')).toEqual(['n ǐ h ǎo ch āo b ǎo', 'n í h ǎo ch āo b ǎo']);
  });
  it('换唤醒词自动生成，y/w 按声母切、连续三声加变调读法', () => {
    const tokens = kwsTokens('你好小圆');
    expect(tokens[0]).toBe('n ǐ h ǎo x iǎo y uán');
    expect(tokens).toContain('n í h ǎo x iǎo y uán');
    expect(tokens).toContain('n í h áo x iǎo y uán');
    expect(tokens.length).toBeLessThanOrEqual(4);
    expect(kwsTokens('小爱同学')).toEqual(['x iǎo ài t óng x ué']);
    expect(kwsTokens('hello')).toEqual([]);
  });
});
describe('音频与协议边界', () => {
  it('环形缓冲保留精确尾部，不持有可变输入', () => {
    const ring = new AudioRing(8);
    const a = Buffer.from([1, 2, 3, 4, 5, 6]);
    ring.push(a);
    a.fill(0);
    ring.push(Buffer.from([7, 8, 9, 10, 11, 12]));
    expect([...ring.snapshot()]).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
    ring.clear();
    expect(ring.snapshot()).toHaveLength(0);
  });
  it('支持带停顿标点的一句话直达', () => {
    expect(stripWake('你好，超宝，介绍一下自己。', '你好超宝')).toBe('介绍一下自己。');
    expect(stripWake('介绍一下自己', '你好超宝')).toBe('介绍一下自己');
  });
  it('附和词不能误删有内容的命令', () => {
    expect(isBackchannel('嗯，对。')).toBe(true);
    expect(isBackchannel('好，帮我介绍一下')).toBe(false);
    expect(incomplete('帮我订一个')).toBe(true);
    expect(incomplete('介绍一下你自己。')).toBe(false);
  });
  it('只说了动词或句尾是连接词时判为明显没说完，已带宾语的照常断句', () => {
    for (const t of [
      '帮我查询',
      '帮我查询。',
      '我想查一下',
      '打开',
      '麻烦帮我看看',
      '还有',
      '帮我订一个',
    ])
      expect(incompleteLevel(t), t).toBe(2);
    for (const t of [
      '把灯打开',
      '帮我查询库存',
      '查一下A01的库存。',
      '明天天气怎么样',
      '介绍一下你自己',
    ])
      expect(incompleteLevel(t), t).toBe(0);
    expect(incompleteLevel('要红色的')).toBe(1);
  });
  it('估算时间戳显式标记且有序', () => {
    const marks = estimatedMarks('你好', 400);
    expect(marks[1]).toEqual({ char: '好', startMs: 200, endMs: 400, estimated: true });
  });
  it('拒绝过长文本和负播放位置', () => {
    expect(clientEventSchema.safeParse({ type: 'text', text: 'x'.repeat(2001) }).success).toBe(
      false,
    );
    expect(
      clientEventSchema.safeParse({ type: 'interrupt', reason: 'stop', heardChars: -1 }).success,
    ).toBe(false);
  });
});
