'use strict';

// 纯逻辑单测(无 IO):显示文本 → 播报文本(语音精简)。
// 「弹窗/字幕显示完整回复,语音只念含数字的片段」这条规则全在 server/speech.js 里。
// 运行:node test/speech.test.js
const assert = require('assert');
const { toSpeechText, normalizeMode, hasNumber, stripMarkup, DEFAULT_MODE } = require('../server/speech');

// ---- 模式归一化:未配置/写错都落回默认(默认=只播数字片段) ----
assert.strictEqual(DEFAULT_MODE, 'key-numbers');
assert.strictEqual(normalizeMode(undefined), 'key-numbers');
assert.strictEqual(normalizeMode('莫名其妙'), 'key-numbers');
assert.strictEqual(normalizeMode('full'), 'full');

// ---- key-numbers:只留含数字的片段,纯叙述丢掉 ----
assert.strictEqual(
  toSpeechText('当前库存总量为 12,345 件，其中原材料 5,678 件，此外建议关注临期物料。'),
  '当前库存总量为 12,345 件，其中原材料 5,678 件，'
);
// 该句没有任何数字 → 空串(调用方据此跳过这句 TTS)
assert.strictEqual(toSpeechText('建议您关注临期物料，及时安排出库。'), '');
assert.strictEqual(toSpeechText('好的，我明白了。'), '');
// 数字在中间片段/句末片段都能留下
assert.strictEqual(toSpeechText('今天入库 320 单，出库正常。'), '今天入库 320 单，');
assert.strictEqual(toSpeechText('一切正常，库存 8 件。'), '库存 8 件。');
// 全角数字同样算数字
assert.strictEqual(toSpeechText('库存 １２３ 件，其余正常。'), '库存 １２３ 件，');
// 多片段全留,顺序不变
assert.strictEqual(
  toSpeechText('A 区 10 件；B 区 20 件；C 区暂无。'),
  'A 区 10 件；B 区 20 件；'
);
// 百分号/千分位/小数点都随片段一起念
assert.strictEqual(toSpeechText('库容利用率 82.5%，超期 0 件。'), '库容利用率 82.5%，超期 0 件。');

// ---- full:不精简,只做排版清理 ----
const fullText = '库存总量 12,345 件，建议关注临期物料。';
assert.strictEqual(toSpeechText(fullText, 'full'), fullText);
assert.strictEqual(toSpeechText('## 库存\n建议关注。', 'full'), '库存 建议关注。');

// ---- Markdown 排版噪声不念出来 ----
assert.strictEqual(stripMarkup('**库存** 12 件'), '库存 12 件');
assert.strictEqual(stripMarkup('| 物料 | 数量 |\n| A | 12 |'), '物料 数量 A 12');
assert.strictEqual(toSpeechText('| 物料 | 数量 |\n| A | 12 |'), '物料 数量 A 12');
assert.strictEqual(stripMarkup('见 [报表](http://x/report) 12 条'), '见 报表 12 条');
assert.strictEqual(stripMarkup('```json\n{"a":1}\n```'), ''); // 纯代码块清完只剩空

// ---- 边界 ----
assert.strictEqual(toSpeechText(''), '');
assert.strictEqual(toSpeechText(null), '');
assert.strictEqual(toSpeechText(undefined, 'full'), '');
assert.strictEqual(hasNumber('12'), true);
assert.strictEqual(hasNumber('十二'), false);

console.log('speech.test.js 全部通过');
