'use strict';

// 流式问答管线单测(不联网、不合成):用桩替换 LLM 与 TTS,驱动整条 StreamPipeline,验证
//   1) 推给前端的 delta / done.replyText = LLM 完整回复(弹窗/字幕照全文显示);
//   2) 真正送去合成的句子 = 精简后的播报文本(默认只留含数字的片段);
//   3) done.speechText = 实际播报文本;
//   4) 整段回复没有数字时兜底播完整回复(不至于有问无声);speech.mode='full' 时播报=完整回复。
// 运行:node test/stream-speech.test.js
const assert = require('assert');
const config = require('../server/config');
const tts = require('../server/tts');
const turn = require('../server/turn');
const { StreamPipeline } = require('../server/stream');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 造一个假 ws:文本帧按 JSON 收集,二进制帧只记长度 */
function fakeWs() {
  const frames = [];
  return {
    frames,
    readyState: 1,
    OPEN: 1,
    send(data) {
      if (typeof data === 'string') frames.push(JSON.parse(data));
      else frames.push({ type: 'pcm', bytes: data.length });
    },
    json(type) {
      return frames.filter((f) => f.type === type);
    },
  };
}

/** 桩掉 LLM(逐字增量)与 TTS(只记录送合成的文本) */
function stub(replyText) {
  const synthesized = [];
  turn.askStream = async (text, sessionId, onDelta) => {
    for (const ch of replyText) onDelta(ch);
    return { replyText, userText: text };
  };
  tts.synthesizeStream = (text) => {
    synthesized.push(text);
    return { promise: Promise.resolve(), cancel() {} };
  };
  return synthesized;
}

async function run(replyText) {
  const ws = fakeWs();
  const pipeline = new StreamPipeline(ws, 'test-session');
  pipeline.start('库存还有多少');
  await wait(250); // 等 LLM 增量 → 断句 → 逐句"合成" → drain → done
  return ws;
}

(async () => {
  // 测试自己钉住播报模式：不能依赖开发机 server/config/local.json 里配了什么
  // （比如本地把 speech.mode 改成 llm 后，用例会去打真实 LLM 而超时）。
  const realSpeech = config.speech;
  config.speech = { mode: 'key-numbers' };

  // ---- 1) 默认(key-numbers):显示完整,只念含数字的片段 ----
  const REPLY = '当前库存总量为 12,345 件，其中原材料 5,678 件，此外建议关注临期物料。';
  const SPOKEN = '当前库存总量为 12,345 件，其中原材料 5,678 件。';
  let synthesized = stub(REPLY);
  let ws = await run(REPLY);

  assert.strictEqual(
    ws.json('delta').map((d) => d.text).join(''),
    REPLY,
    'delta 必须是完整回复(弹窗显示完整)'
  );
  const done = ws.json('done')[0];
  assert.ok(done, '必须收到 done');
  assert.strictEqual(done.replyText, REPLY, 'done.replyText 是完整回复');
  assert.strictEqual(done.speechText, SPOKEN, 'done.speechText 是实际播报文本');
  assert.deepStrictEqual(synthesized, [SPOKEN], '只把含数字的片段送去合成');
  assert.ok(
    ws.frames.some((f) => f.type === 'meta'),
    'meta 必须先于二进制帧下发'
  );

  // ---- 2) 整段没有数字:兜底播完整回复(按句) ----
  const CHITCHAT = '好的，我明白了。请随时吩咐。';
  synthesized = stub(CHITCHAT);
  ws = await run(CHITCHAT);
  assert.strictEqual(ws.json('delta').map((d) => d.text).join(''), CHITCHAT);
  assert.strictEqual(ws.json('done')[0].replyText, CHITCHAT);
  assert.deepStrictEqual(synthesized, ['好的，我明白了。', '请随时吩咐。'], '没数字时兜底按句播完整回复');

  // ---- 3) 表格行/ID 这类"只有数字没单位"的句子:整段有关键数字时不念 ----
  const TABLE_REPLY =
    '| 数据源 | 核查内容 | 结果 |\n' +
    '| 聚能医工知识库（kb_c0c1jyi65t） | 检索库存 | 无仓储数据 |\n' +
    '综上所述，到货计划 0 条，到货清单 0 条。';
  synthesized = stub(TABLE_REPLY);
  ws = await run(TABLE_REPLY);
  assert.deepStrictEqual(synthesized, ['到货计划 0 条，到货清单 0 条。'], '表格行/ID 不该被念，只念带单位的关键数字');
  assert.strictEqual(ws.json('done')[0].speechText, '到货计划 0 条，到货清单 0 条。');

  // ---- 4) 整段都没有带单位的关键数字:退回播"纯数字片段"(而不是把整段念完) ----
  const PLAIN_REPLY = '业务日期 2026-09-29，编号 kb_c0c1jyi65t。';
  synthesized = stub(PLAIN_REPLY);
  ws = await run(PLAIN_REPLY);
  assert.strictEqual(synthesized.length, 1, `纯数字兜底应合成 1 句：${JSON.stringify(synthesized)}`);
  assert.ok(/2026-09-29/.test(synthesized[0]), `兜底要念出数字：${synthesized[0]}`);

  // ---- 5) speech.mode = 'full':播报 = 完整回复 ----
  const prevMode = config.speech && config.speech.mode;
  config.speech = { mode: 'full' };
  try {
    synthesized = stub(REPLY);
    ws = await run(REPLY);
    assert.deepStrictEqual(synthesized, [REPLY], 'full 模式播报完整回复');
    assert.strictEqual(ws.json('done')[0].speechText, REPLY);
  } finally {
    config.speech = { mode: prevMode || 'key-numbers' };
  }

  // ---- 6) speech.mode = 'llm':播报文本走**单独一条 LLM 链路**改写,弹窗仍是完整回答 ----
  const llm = require('../server/llm');
  const prevSpeech = config.speech;
  const prevAskOnce = llm.askOnce;
  const SUMMARY = '库存总量一万两千三百四十五件，原材料五千六百七十八件。';
  let sawSystem = '';
  let sawModel = '';
  llm.askOnce = async (user, opts) => {
    sawSystem = opts.system || '';
    sawModel = (opts.config && opts.config.model) || '';
    assert.ok(/库存总量/.test(user), '改写输入要带主链路完整回答');
    return SUMMARY;
  };
  config.speech = {
    mode: 'llm',
    summary: { provider: 'openai-compatible', baseUrl: 'http://summary.local/v1', model: 'summary-model', apiKey: 'k' },
  };
  try {
    synthesized = stub(REPLY);
    ws = await run(REPLY);
    assert.ok(/数字人播报员/.test(sawSystem), `要用数字人播报员角色提示：${sawSystem.slice(0, 40)}`);
    assert.ok(/不要念表格|表格/.test(sawSystem), '角色提示要禁止念表格/代码');
    assert.strictEqual(sawModel, 'summary-model', '要走 speech.summary 这条独立链路（独立模型）');
    assert.strictEqual(ws.json('delta').map((d) => d.text).join(''), REPLY, '弹窗/delta 仍是完整回答');
    assert.strictEqual(ws.json('done')[0].replyText, REPLY, 'done.replyText 仍是完整回答');
    assert.strictEqual(ws.json('done')[0].speechText, SUMMARY, 'done.speechText = 改写后的播报文本');
    assert.deepStrictEqual(synthesized, [SUMMARY], 'TTS 只念改写后的文本');

    // 改写失败 → 退回规则精简（不能因此没声音）
    llm.askOnce = async () => { throw new Error('改写超时'); };
    synthesized = stub(REPLY);
    ws = await run(REPLY);
    assert.deepStrictEqual(synthesized, [SPOKEN], '改写失败要退回规则精简');
    assert.strictEqual(ws.json('done')[0].speechText, SPOKEN);
  } finally {
    llm.askOnce = prevAskOnce;
    config.speech = prevSpeech;
  }

  config.speech = realSpeech; // 还原开发机配置
  console.log('stream-speech.test.js 全部通过');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
