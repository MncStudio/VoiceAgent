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

// ---- 自定义打断词可配置(config.wakeStopWords 覆盖默认) ----
const det2 = new WakeDetector(['你好小智'], () => {}, 10000, {}, ['安静点']);
assert.strictEqual(det2.matchStop('安静点'), true);
assert.strictEqual(det2.matchStop('别说了'), false); // 默认词表已被覆盖

console.log('wake.test.js 全部通过');
