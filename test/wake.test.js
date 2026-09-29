'use strict';

// 纯逻辑单测(不依赖 ffmpeg/ONNX/网络):归一化、拼音、唤醒词匹配、语义化打断判定。
// 运行:node test/wake.test.js
const assert = require('assert');
const { WakeDetector, _test } = require('../server/wake');

const { normalize, toSyllables, findSubseq } = _test;

// ---- normalize:去空白/全半角标点/转小写 ----
assert.strictEqual(normalize(' 你好，小智！ '), '你好小智');
assert.strictEqual(normalize('Stop the music.'), 'stopthemusic');

// ---- toSyllables:逐字转拼音(忽略声调),与原文一字对应 ----
assert.deepStrictEqual(toSyllables('小智'), ['xiao', 'zhi']);

// ---- findSubseq:连续子序列 ----
assert.strictEqual(findSubseq(['ni', 'hao', 'xiao', 'zhi'], ['xiao', 'zhi']), 2);
assert.strictEqual(findSubseq(['zhi'], ['xiao']), -1);

// ---- 默认检测器 ----
const det = new WakeDetector(['你好小智'], () => {}, 10000);

// match:字符精确命中 + 剥词
assert.deepStrictEqual(det.match('你好小智'), { word: '你好小智', rest: '' });
// match:拼音模糊(志/智同音)也能命中
assert.strictEqual(det.match('你好小志').word, '你好小智');

// matchStop:命中打断词(长度 ≤ stopMaxLen 且含词表词)
assert.strictEqual(det.matchStop('别说了'), true);
assert.strictEqual(det.matchStop('停下'), true);
// 过短语气词不判打断
assert.strictEqual(det.matchStop('嗯'), false);
// 超长(正常问句)不判打断
assert.strictEqual(det.matchStop('为什么停止播放这个功能'), false);
// 请求句(含打断词但剥词后剩实词)不判打断 —— 外部声音/句子不误断的关键
assert.strictEqual(det.matchStop('帮我暂停一下'), false);
// 带主语/语气的祈使句仍判打断
assert.strictEqual(det.matchStop('你别说了'), true);
assert.strictEqual(det.matchStop('停一下好吗'), true);
assert.strictEqual(det.matchStop('安静点'), true);
// 拼音同音容错(硕/说同音)仍判打断
assert.strictEqual(det.matchStop('别硕了'), true);
// 含打断词音节的请求句不判打断(字符分支剥词后含实词)
assert.strictEqual(det.matchStop('帮我暂停一下'), false);

// ---- 自定义打断词可配置(config.wakeStopWords 覆盖默认) ----
const det2 = new WakeDetector(['你好小智'], () => {}, 10000, {}, ['安静点']);
assert.strictEqual(det2.matchStop('安静点'), true);
assert.strictEqual(det2.matchStop('别说了'), false); // 默认词表已被覆盖

// ---- match:字符命中时 rest 取原文剥词(保留空格/标点,别把送 LLM 的文本压扁) ----
assert.deepStrictEqual(det.match('你好小智 How are you?'), { word: '你好小智', rest: 'How are you?' });
assert.deepStrictEqual(det.match('今天天气如何？你好小智'), { word: '你好小智', rest: '今天天气如何？' });
assert.strictEqual(det.match('你好小智 帮我查下 WMS 库存').rest, '帮我查下 WMS 库存');
// 唤醒词字面不在原文(ASR 同音字 志/智)时走拼音匹配 → 退回归一化剥词
assert.strictEqual(det.match('你好小志 What time is it?').rest, 'whattimeisit');
assert.strictEqual(det.match('你好小志').word, '你好小智');

console.log('wake.test.js 全部通过');

// ---- 每次提问都带唤醒词(config.wakeRequireWord) ----
// classify 走 ASR(需要网络/ffmpeg),这里把 asr.recognizeBuffer 换成固定文本的桩,
// 只验证"识别到这段话后唤醒器怎么决策"这一层纯逻辑。
const asr = require('../server/asr');
let nextText = '';
asr.recognizeBuffer = async () => nextText;

function makeDetector(events, requireWake) {
  return new WakeDetector(
    ['你好小智'],
    (type, payload) => events.push({ type, ...payload }),
    10000,
    {},
    undefined,
    undefined,
    requireWake
  );
}

async function feed(det, text) {
  nextText = text;
  det.classify(Buffer.alloc(0)); // wav 内容由上面的桩忽略
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

(async () => {
  // 1) 开启后:带唤醒词只答本句,不开窗口
  {
    const events = [];
    const det = makeDetector(events, true);
    await feed(det, '你好小智 库存还有多少');
    assert.deepStrictEqual(events, [
      { type: 'wake', word: '你好小智', timeoutSeconds: 10 },
      { type: 'answer', userText: '库存还有多少' },
      { type: 'sleep', idleSeconds: 0 },
    ]);
    assert.strictEqual(det.armed, false); // 不开"窗口内免唤醒词"的窗口
    assert.strictEqual(det.sleepTimer, null); // 也不需要休眠倒计时
    det.close();
  }

  // 2) 开启后:没带唤醒词的话整段丢弃(第二句也不会被当问题)
  {
    const events = [];
    const det = makeDetector(events, true);
    await feed(det, '库存还有多少');
    assert.deepStrictEqual(events, []);
    await feed(det, '你好小智 那入库呢');
    assert.deepStrictEqual(events.map((e) => e.type), ['wake', 'answer', 'sleep']);
    // 紧接着的下一句又必须带唤醒词
    events.length = 0;
    await feed(det, '那入库呢');
    assert.deepStrictEqual(events, []);
    det.close();
  }

  // 3) 只说唤醒词:仍回固定问候
  {
    const events = [];
    const det = makeDetector(events, true);
    await feed(det, '你好小智');
    assert.strictEqual(events[0].type, 'wake');
    assert.deepStrictEqual(events[1], { type: 'answer', userText: '你好小智', replyText: '我在，请讲' });
    det.close();
  }

  // 4) 手动唤醒(用户主动点按钮)仍开一次窗口:窗口内整句直接问
  {
    const events = [];
    const det = makeDetector(events, true);
    det.armed = true; // 等价于收到 {"type":"wake_manual"}
    det.lastActiveAt = Date.now();
    await feed(det, '库存还有多少');
    assert.deepStrictEqual(events, [{ type: 'answer', userText: '库存还有多少' }]);
    det.close();
  }

  // 5) 默认(未开启):命中唤醒词后开窗口,下一句免唤醒词
  {
    const events = [];
    const det = makeDetector(events, false);
    await feed(det, '你好小智 库存还有多少');
    assert.strictEqual(det.armed, true);
    events.length = 0;
    await feed(det, '那入库呢');
    assert.deepStrictEqual(events, [{ type: 'answer', userText: '那入库呢' }]);
    det.close();
  }

  console.log('wake.test.js 唤醒词/每次提问带唤醒词 全部通过');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
