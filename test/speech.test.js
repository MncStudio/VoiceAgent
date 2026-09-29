'use strict';

// 纯逻辑单测(无 IO):显示文本 → 播报文本(语音只报关键数字)。
// 「弹窗/字幕显示完整回复,语音只念关键数字」这条规则全在 server/speech.js 里。
// 运行:node test/speech.test.js
const assert = require('assert');
const {
  toSpeechText,
  normalizeMode,
  hasNumber,
  stripMarkup,
  speechParts,
  buildSummaryPrompt,
  DEFAULT_SUMMARY_SYSTEM,
  DEFAULT_MODE,
} = require('../server/speech');

// 规则精简模式的断言助手（默认模式已改成 full，所以这里显式指定 key-numbers）
const kn = (t, m = 'key-numbers') => toSpeechText(t, m);

// ---- 模式归一化:未配置/写错都落回默认(默认=full,LLM 答什么就播什么) ----
assert.strictEqual(DEFAULT_MODE, 'full'); // 默认：LLM 答什么就播什么
assert.strictEqual(normalizeMode(undefined), 'full');
assert.strictEqual(normalizeMode('莫名其妙'), 'full');
assert.strictEqual(normalizeMode('full'), 'full');

// ---- key-numbers:只留含数字的片段,叙述丢掉 ----
assert.strictEqual(
  kn('当前库存总量为 12,345 件，其中原材料 5,678 件，此外建议关注临期物料。'),
  '当前库存总量为 12,345 件，其中原材料 5,678 件。'
);
// 该句没有任何数字 → 空串(调用方据此跳过这句 TTS,整段都没数字时由 stream.js 兜底播完整回复)
assert.strictEqual(kn('建议您关注临期物料，及时安排出库。'), '');
assert.strictEqual(kn('好的，我明白了。'), '');
// 全角数字同样算数字
assert.strictEqual(kn('库存 １２３ 件，其余正常。'), '库存 １２３ 件。');
// 百分号/小数点照念
assert.strictEqual(kn('库容利用率 82.5%，超期 0 件。'), '库容利用率 82.5%，超期 0 件。');
// 多片段按顺序保留,片段间补逗号
assert.strictEqual(kn('A 区 10 件；B 区 20 件；C 区暂无。'), 'A 区 10 件，B 区 20 件。');

// ---- 千分位不能被当成片段边界(曾把 12,345 念成 345) ----
assert.strictEqual(kn('库存总量 12,345 件。'), '库存总量 12,345 件。');
assert.strictEqual(kn('入库 1,234,567 吨，出库 9 吨。'), '入库 1,234,567 吨，出库 9 吨。');

// ---- 优先"数字+单位"的业务数字;序号/日期/ID 这类只有数字不算 ----
assert.strictEqual(kn('1. 库存 320 件。2. 审批人张三（工号 10086）。'), '库存 320 件。');
assert.strictEqual(
  kn('业务日期 2026-09-29，到货计划数 0 条，到货清单数 0 条。'),
  '到货计划数 0 条，到货清单数 0 条。'
);

// ---- 播报要短:总长封顶,长叙述不念 ----
const longAnswer =
  '我实际核查了什么。当前账号可访问的知识库只有一个（编号 kb_c0c1jyi65t），' +
  '该库内仅包含一个 md 文件，内容为西安聚能医工科技有限公司的企业介绍（成立时间、股东构成、' +
  '注册资本、超导重离子加速器与无液氦超导 MRI 业务、产学研合作、发展愿景等），' +
  '其中没有任何仓储、库存、库容、利用率相关的章节或指标，因此库存总量与库容利用率均无法取值。' +
  '系统目前提供的仓储口径数据只有到货维度：到货计划数 0 条，到货清单数 0 条，仓库范围全部仓库。';
const longSpeech = kn(longAnswer);
assert.ok(longSpeech.length <= 80, `播报总长应封顶 80，实际 ${longSpeech.length}：${longSpeech}`);
assert.ok(!/kb_c0c1jyi65t|成立时间/.test(longSpeech), `长叙述不该被念：${longSpeech}`);
assert.ok(/0 条/.test(longSpeech), `关键数字要保留：${longSpeech}`);

// ---- HTML / 内联样式:不能把 CSS 当业务数据念出来(线上实测踩过) ----
assert.strictEqual(
  kn('<div style="font-size:13px;color:#6b7280;padding:10px">库容利用率 82.5%，超期 0 件。</div>'),
  '库容利用率 82.5%，超期 0 件。'
);
assert.strictEqual(kn('padding: 12px 14px;color: #1f2937;'), '');
assert.strictEqual(kn('font-size:13px;font-weight:600;line-height:1.4'), '');
assert.strictEqual(kn('<span style="margin-right:8px">今日到货计划</span>'), '');
assert.strictEqual(
  kn('<style>.a{font-size:13px;color:#6b7280}</style>今日到货清单 3 条，其中待收货 1 条。'),
  '今日到货清单 3 条，其中待收货 1 条。'
);
// 线上抓到的真实样式碎片样本:CSS 片段一律不念(含样式的片段整段丢弃),且总长封顶
const cssSample =
  '08px 4px;100%;13px; 5b6472;10px" 业务日期 2026-09-29 · 更新时间 16:39</div10px" ' +
  '1 1 160px;150px;1px solid e3e7ee;10px;12px 14px"12px; 6b7280" 今日到货计划</div26px;600; 1f2937;1.4"0 条</span';
const cssSpeech = kn(cssSample);
assert.ok(cssSpeech.length <= 80, `播报总长封顶：${cssSpeech}`);
assert.ok(
  !/\d+px|;|\{|\}|="|<\/|solid|#[0-9a-f]{6}/i.test(cssSpeech),
  `不该把样式念出来：${cssSpeech}`
);

// ---- full:不精简,只做排版清理 ----
const fullText = '库存总量 12,345 件，建议关注临期物料。';
assert.strictEqual(kn(fullText, 'full'), fullText);
assert.strictEqual(kn('<div>库存</div>建议关注。', 'full'), '库存 建议关注。'); // 去标签会留一个空格

// ---- Markdown 排版噪声不念出来 ----
assert.strictEqual(stripMarkup('**库存** 12 件'), '库存 12 件');
assert.strictEqual(kn('| 物料 | 数量 |\n| A | 12 件 |'), 'A 12 件。'); // 表头无数字不念,只念有数的那行
assert.strictEqual(stripMarkup('见 [报表](http://x/report) 12 条'), '见 报表 12 条');
assert.strictEqual(stripMarkup('```json\n{"a":1}\n```'), ''); // 纯代码块清完只剩空

// ---- 'llm' 模式:播报文本由单独 LLM 链路改写,这里只测提示词组装 ----
assert.strictEqual(normalizeMode('llm'), 'llm');
assert.ok(/数字人播报员/.test(DEFAULT_SUMMARY_SYSTEM), '默认角色 = 数字人播报员');
assert.ok(/表格/.test(DEFAULT_SUMMARY_SYSTEM) && /代码/.test(DEFAULT_SUMMARY_SYSTEM), '默认角色要禁止念表格/代码');
{
  const { system, user } = buildSummaryPrompt('| 项目 | 值 |\n| 库存总量 | 12,345 件 |', '库存还有多少');
  assert.strictEqual(system, DEFAULT_SUMMARY_SYSTEM);
  assert.ok(user.includes('用户问题：库存还有多少'), '提示里要带原问题');
  assert.ok(user.includes('12,345'), '提示里要带完整回答供改写');
  // 自定义角色提示可覆盖
  const custom = buildSummaryPrompt('随便答一句', '问题', { system: '你是播报员,只念数字' });
  assert.strictEqual(custom.system, '你是播报员,只念数字');
  // 没问题/没回答也不报错
  assert.ok(buildSummaryPrompt('', '').user.length > 0);
}

// ---- speechParts:withUnit / plain 两类片段(stream.js 按整段决定兜底) ----
{
  const p1 = speechParts('聚能医工知识库（kb_c0c1jyi65t） 无仓储数据。到货计划 0 条。', 'key-numbers');
  assert.strictEqual(p1.withUnit, '到货计划 0 条。');
  assert.ok(/kb/.test(p1.plain), `纯数字片段应含 ID：${p1.plain}`);
  const p2 = speechParts('业务日期 2026-09-29。', 'key-numbers');
  assert.strictEqual(p2.withUnit, '');
  assert.ok(/2026-09-29/.test(p2.plain));
}

// ---- 边界 ----
assert.strictEqual(kn(''), '');
assert.strictEqual(kn(null), '');
assert.strictEqual(kn(undefined, 'full'), '');
assert.strictEqual(hasNumber('12'), true);
assert.strictEqual(hasNumber('十二'), false);

console.log('speech.test.js 全部通过');
