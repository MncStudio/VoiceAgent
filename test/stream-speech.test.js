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
  // ---- 1) 默认(key-numbers):显示完整,只念含数字的片段 ----
  const REPLY = '当前库存总量为 12,345 件，其中原材料 5,678 件，此外建议关注临期物料。';
  const SPOKEN = '当前库存总量为 12,345 件，其中原材料 5,678 件，';
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

  // ---- 3) speech.mode = 'full':播报 = 完整回复 ----
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

  console.log('stream-speech.test.js 全部通过');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
