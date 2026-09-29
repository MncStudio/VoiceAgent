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
assert.strictEqual(det.requireWake, true, '默认每次提问都需要唤醒词');
assert.strictEqual(det.threshold, 0.45, '默认 VAD 门槛应兼顾短促唤醒词');

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

// ---- 音节级模糊容错:口音 / ASR 误识别(现场实测报回来的) ----
// 「你好超宝」被识别成 你要抄本 / 你好超本 / 你好超板 / 你好小宝 … 都要能叫醒。
{
  // 两个词：你好超宝（超/抄/曹/本/板 这条线）+ 你好小超（小 这条线，现场报过「你好小宝」）
  const fuzzy = new WakeDetector(['你好超宝', '你好小超'], () => {}, 10000);
  // 用户实测的三条 + 常见口音变体
  assert.deepStrictEqual(fuzzy.match('你要抄本。1加1等于多少？'), { word: '你好超宝', rest: '1加1等于多少' });
  assert.deepStrictEqual(fuzzy.match('你好，超本1加1等于多少？'), { word: '你好超宝', rest: '1加1等于多少' });
  assert.deepStrictEqual(fuzzy.match('你好，超板1加1等于多少？'), { word: '你好超宝', rest: '1加1等于多少' });
  assert.deepStrictEqual(fuzzy.match('你好小宝，库存多少'), { word: '你好小超', rest: '库存多少' });
  assert.ok(fuzzy.match('你好超薄'), '同音字仍要命中');
  assert.ok(fuzzy.match('你好抄报'), '同音字仍要命中');
  // 不能因此误触(首音节必须一致 + 每音节至少半像 + 平均 0.75)
  for (const t of [
    '库存还有多少', '今天到货计划几条', '开始盘点', '帮我查一下库容利用率',
    '你们发货了吗', '你好好干', '你要不要', '你好我是小王', '还有多少库存', '小曹你在吗',
  ]) {
    assert.strictEqual(fuzzy.match(t), null, `模糊匹配不该误触:${t}`);
  }
  // 关掉模糊(config.wakeFuzzyMatch=false)后只剩精确/拼音命中
  const strict = new WakeDetector(['你好超宝'], () => {}, 10000, {}, undefined, undefined, false, 0, false);
  assert.strictEqual(strict.match('你要抄本1加1等于多少'), null);
  assert.ok(strict.match('你好超宝'));
  // 音节相似度本身
  const { syllableScore } = require('../server/wake')._test;
  assert.strictEqual(syllableScore('bao', 'bao'), 1);
  assert.strictEqual(syllableScore('bao', 'ben'), 0.5, '声母同、韵母不同 = 半像');
  assert.strictEqual(syllableScore('hao', 'yao'), 0.5, '韵母同、声母不同 = 半像');
  assert.strictEqual(syllableScore('bao', 'shi'), 0);
}

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
  // 1) 首段即使识别出尾字，也只唤醒；下一段说话结束后立即提交
  {
    const events = [];
    const det = makeDetector(events, true);
    await feed(det, '你好小智 库存还有多少');
    assert.deepStrictEqual(events, [
      { type: 'wake', word: '你好小智', timeoutSeconds: 5, followUp: true },
      { type: 'interrupt' },
    ]);
    assert.strictEqual(det.armed, true);
    await feed(det, '库存还有多少');
    assert.deepStrictEqual(events.slice(2), [
      { type: 'answer', userText: '库存还有多少' },
      { type: 'sleep', idleSeconds: 0 },
    ]);
    assert.strictEqual(det.armed, false);
    assert.strictEqual(det.sleepTimer, null);
    det.close();
  }

  // 2) 开启后:没带唤醒词的话整段丢弃(第二句也不会被当问题)
  {
    const events = [];
    const det = makeDetector(events, true);
    await feed(det, '库存还有多少');
    assert.deepStrictEqual(events, []);
    await feed(det, '你好小智 那入库呢');
    assert.deepStrictEqual(events.map((e) => e.type), ['wake', 'interrupt']);
    await feed(det, '那入库呢');
    assert.deepStrictEqual(events.slice(2), [
      { type: 'answer', userText: '那入库呢' },
      { type: 'sleep', idleSeconds: 0 },
    ]);
    // 本轮答完后，下一句又必须带唤醒词
    events.length = 0;
    await feed(det, '那入库呢');
    assert.deepStrictEqual(events, []);
    det.close();
  }

  // 3) 只说唤醒词:安静等待提问，不立即播报或调用问答
  {
    const events = [];
    const det = makeDetector(events, true);
    await feed(det, '你好小智');
    assert.deepStrictEqual(events.map((e) => e.type), ['wake', 'interrupt']);
    assert.deepStrictEqual(events[0], { type: 'wake', word: '你好小智', timeoutSeconds: 5, followUp: true });
    assert.strictEqual(det.armed, true, '只说唤醒词要开窗口等你提问');
    assert.strictEqual(det.armedTimeoutMs, 5000, '窗口用 followUp 时长(默认 5s)，不是 5 分钟的 wakeTimeout');
    const firstTimer = det.sleepTimer;
    det.playbackEnded();
    assert.strictEqual(det.sleepTimer, firstTimer, '旧回答结束不能重置思考时间');
    events.length = 0;
    await feed(det, '你好小智');
    assert.deepStrictEqual(events, [], '窗口内重复喊唤醒词也不能立即回答');
    assert.notStrictEqual(det.sleepTimer, firstTimer, '重复唤醒应重新给足等待时间');
    // 窗口内直接提问（不再说唤醒词）
    events.length = 0;
    await feed(det, '库存还有多少');
    assert.deepStrictEqual(events, [
      { type: 'answer', userText: '库存还有多少' },
      { type: 'sleep', idleSeconds: 0 },
    ]);
    assert.strictEqual(det.armed, false, '短窗口只接一问');
    events.length = 0;
    await feed(det, '旁边人的闲聊');
    assert.deepStrictEqual(events, [], '回答后不能继续收环境语音');
    det.close();
  }

  // 3a) 播放中喊唤醒词，先打断旧回答，再接下一段问题。
  {
    const events = [];
    const det = makeDetector(events, true);
    det.playing = true;
    det.playingText = '今天到货计划一条，到货清单零条。';
    await feed(det, '你好小智 库存多少');
    assert.deepStrictEqual(events.map((e) => e.type), ['wake', 'interrupt']);
    det.playbackEnded();
    events.length = 0;
    await feed(det, '库存多少');
    assert.deepStrictEqual(events, [
      { type: 'answer', userText: '库存多少' },
      { type: 'sleep', idleSeconds: 0 },
    ]);
    assert.strictEqual(det.armed, false, '回答后不能留下免唤醒窗口');
    events.length = 0;
    await feed(det, '今天到货计划一条');
    assert.deepStrictEqual(events, [], '外放回声不能引起新回答或打断');
    det.close();
  }

  // 唤醒词是真实喊出的，但 ASR 把原播报接在后面时，不把回声当问题。
  {
    const events = [];
    const det = makeDetector(events, true);
    det.playing = true;
    det.playingText = '到货计划一条，到货清单零条';
    await feed(det, '你好小智 到货计划一条到货清单零条');
    assert.deepStrictEqual(events.map((e) => e.type), ['wake', 'interrupt']);
    det.close();
  }

  // 3b) 没听清唤醒词但用户确实开口时，可以停播；仍不自动问答。
  {
    const events = [];
    const det = makeDetector(events, true);
    det.playing = true;
    det.playingText = '当前库存总量为一万两千件。';
    await feed(det, '当前库存总量为一万两千件');
    assert.deepStrictEqual(events, [], '自己的声音不该打断自己');
    await feed(det, '等一下我有问题');
    assert.deepStrictEqual(events, [{ type: 'interrupt' }]);
    det.close();
  }

  // 3c) 只说唤醒词后，旧回答的播放状态尚未清除时也必须接住问题。
  {
    const events = [];
    const det = makeDetector(events, true);
    await feed(det, '你好小智');
    events.length = 0;
    det.playing = true;
    det.playingText = '旧回答';
    await feed(det, '库存还有多少');
    assert.deepStrictEqual(events, [
      { type: 'interrupt' },
      { type: 'answer', userText: '库存还有多少' },
      { type: 'sleep', idleSeconds: 0 },
    ]);
    det.close();
  }

  // 3d) 同段的 ASR 尾字不会触发回答；5 秒内没有下一段就休眠
  {
    const events = [];
    const det = makeDetector(events, true);
    await feed(det, '你好小智 库存还有多少');
    assert.deepStrictEqual(events.map((e) => e.type), ['wake', 'interrupt']);
    det._scheduleSleep(1);
    await new Promise((r) => setTimeout(r, 10));
    assert.deepStrictEqual(events.map((e) => e.type), ['wake', 'interrupt', 'sleep']);
    assert.strictEqual(det.armed, false);
    det.close();
  }

  // 3e) 期限前开口后，要等整句和 ASR 完成，不可在识别途中休眠。
  {
    const events = [];
    const det = makeDetector(events, true);
    await feed(det, '你好小智');
    det._scheduleSleep(1);
    det.onFrame(1, new Float32Array(512));
    det.onFrame(1, new Float32Array(512));
    assert.strictEqual(det.sleepTimer, null, '用户开口时暂停倒计时');
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(det.armed, true, '用户已开口，不能因 5 秒窗口到期丢掉问题');
    const pending = [];
    asr.recognizeBuffer = () => new Promise((resolve) => pending.push(resolve));
    det.classify(Buffer.alloc(0));
    assert.strictEqual(pending.length, 1);
    pending.shift()('库存还有多少');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(events.slice(2), [
      { type: 'answer', userText: '库存还有多少' },
      { type: 'sleep', idleSeconds: 0 },
    ]);
    det.close();
    asr.recognizeBuffer = async () => nextText;
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

  // 5) 显式长窗口模式：首次仍只唤醒，下一段问题后恢复长窗口
  {
    const events = [];
    const det = makeDetector(events, false);
    await feed(det, '你好小智 库存还有多少');
    assert.strictEqual(det.armed, true);
    events.length = 0;
    await feed(det, '那入库呢');
    assert.deepStrictEqual(events, [{ type: 'answer', userText: '那入库呢' }]);
    assert.strictEqual(det.armedTimeoutMs, det.wakeTimeoutMs);
    det.close();
  }

  // 在线 ASR 正忙时，下一段不能直接丢掉（常见于先喊唤醒词、马上问问题）。
  {
    const events = [];
    const det = makeDetector(events, true);
    const pending = [];
    asr.recognizeBuffer = () => new Promise((resolve) => pending.push(resolve));
    det.classify(Buffer.from([1]));
    det.classify(Buffer.from([2]));
    assert.strictEqual(pending.length, 1);
    assert.strictEqual(det.pendingSegments.length, 1);
    pending.shift()('你好小智');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(pending.length, 1, '首段完成后应开始识别排队的下一段');
    pending.shift()('库存多少');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.ok(events.some((e) => e.type === 'answer' && e.userText === '库存多少'));
    assert.strictEqual(det.pendingSegments.length, 0);
    det.close();
    asr.recognizeBuffer = async () => nextText;
  }

  console.log('wake.test.js 唤醒词/每次提问带唤醒词 全部通过');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
