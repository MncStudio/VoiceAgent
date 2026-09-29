'use strict';

// 「播报文本」与「显示文本」第一次在这里分开：
//   显示文本 = LLM 完整回复 —— `/api/chat_stream` 的 delta 与 done.replyText，前端弹窗/字幕逐字显示，不截断；
//   播报文本 = 只报关键数字 —— 大屏业务答句里"数字"才是用户要听的结果，完整念一遍又慢又啰嗦
//              （"库存总量为 12,345 件，其中原材料 5,678 件，此外建议关注临期物料"
//               → 只念"库存总量为 12,345 件"这类带单位的数字片段）。
// done.speechText 回带实际播报文本（与推给前端的 PCM 一致），便于对账/排查。
//
// 精简规则（按优先级，见 pickSpeechClauses）：
//   1) 先清排版噪声：HTML 标签/style 块、Markdown、CSS 碎片、文件名、列表序号；
//   2) 只留含数字的片段，并**优先带业务单位的**（件/条/%/吨/单…）——「1.」这种序号、
//      「2026-09-29」这种日期、`kb_xxx` 这种 ID 都只有数字没有单位，不会被优先念；
//   3) 片段过长时截到"数字+单位"附近，总长封顶 —— 语音要短，完整内容留给弹窗。
//
// 模式（config.speech.mode）：
//   'key-numbers'（默认）：按上面的规则挑；整段回复一个数字都没有时，
//                          由 stream.js 兜底播完整回复，避免"有问无声"。
//   'full'               ：不精简，播报 = 完整回复（等于关掉本能力，便于回滚/对比）。
//
// 纯逻辑无 IO，可单测（test/speech.test.js）。

// 默认 'full'：**数字人与对话框用同一个 LLM，LLM 答什么数字人就念什么**（只清掉 HTML/Markdown 排版噪声，
// 不会把表格竖线、# 号念出来）。另外两种模式按需在配置里开：
//   'key-numbers' 规则精简：只念「数字+单位」的关键片段（大段结论不念，快且短）
//   'llm'         再起一条独立 LLM 链路把回答改写成口语（角色=数字人播报员，20~50 字）
const DEFAULT_MODE = 'full';
const MODES = new Set(['key-numbers', 'llm', 'full']);

/** 归一化模式：未配置/写错都落回默认值 */
function normalizeMode(mode) {
  return MODES.has(mode) ? mode : DEFAULT_MODE;
}

// LLM 回复常带排版噪声，念出来是噪音，先清掉再挑片段：
//   - HTML：yuxi 的回复里会出现整段 `<div style="font-size:13px…">` 甚至 `<style>` 块，
//     必须先整块删掉再剥标签，否则 style 里的 `13px/100%/e3e7ee` 全是"含数字的片段"，
//     会被当成要播报的内容念出来（实测：语音把 CSS 念了一遍）。
//   - Markdown：标题/加粗/表格竖线/代码/链接。
// 空白（含换行）统一压成单个空格：换行是排版，不该在播报里当停顿。
function stripMarkup(text) {
  return String(text || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')   // <style>…</style> 整块
    .replace(/<script[\s\S]*?<\/script>/gi, ' ') // <script>…</script> 整块
    .replace(/<[^>]*>/g, ' ')                    // 其余 HTML 标签（含 style/class 等属性）
    .replace(/```[\s\S]*?```/g, ' ')             // 代码块
    .replace(/`([^`]*)`/g, '$1')                 // 行内代码
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')   // 链接/图片语法，保留可见文字
    .replace(/[*_#>|]+/g, ' ')                   // 加粗/斜体/标题/引用/表格竖线
    .replace(/\s*\n+\s*/g, '。')                 // 换行/标题/表格行 = 句边界，别和下句黏成一段
    .replace(/\s+/g, ' ')
    .trim();
}

// 片段边界：中英文逗号/分号/顿号/全角冒号 + 句末标点。切分保留标点本身
// （标点决定 TTS 的停顿与韵律，丢掉会把两句黏成一句）。
// 注意**不含半角冒号 `:`**：CSS 声明是 `属性:值` 的形状，按 `:` 切开后属性名（无数字）被丢、
// 值（如 `1.4`）反而被当成数字片段念出来；留着整条一起判，STYLE_NOISE 才认得出来。
const CLAUSE_BOUNDARY = /[，,；;、：。！？!?…]/;
const NUMBER = /[0-9０-９]/;

// 样式/标签碎片：HTML 被剥掉后仍可能剩下 CSS 声明文本或残缺标签（`12px;`、`solid e3e7ee`、
// `font-size:13px`、`line-height:1.4`、`</div`）。这些含数字但不是业务数据，必须排除，
// 否则语音会把样式念一遍（线上实测踩过）。
// 注意不要用 `%` 当判据：「库容利用率 82.5%」是正常内容，要念。
const STYLE_NOISE =
  /[;{}]|(\d+(\.\d+)?(px|pt|em|rem|vh|vw)\b)|(<|>|="|\/>)|\b[0-9a-fA-F]{6}\b|[a-z][a-z-]{2,}\s*:\s*[0-9#]/;

// 业务单位：数字带这些单位的片段才是"要报的结果"（12,345 件 / 82.5% / 0 条 / 3 单…）。
// 没单位的数字多是序号、日期、ID、表格残留，只在实在挑不出带单位的片段时才兜底念。
const BUSINESS_UNIT =
  /\d[\d,.]*\s*(件|条|个|台|套|箱|托|板|吨|千克|公斤|kg|KG|克|升|立方米|m³|平方米|㎡|米|%|％|元|万元|亿元|单|笔|次|天|小时|分钟|秒|人|SKU|sku)/;

/** 单个发言片段最多这么长（超出就截到"数字+单位"附近） */
const MAX_CLAUSE_CHARS = 36;
/** 整段播报总长上限（语音要短，完整内容看弹窗） */
const MAX_SPEECH_CHARS = 80;

// 片段内的排版残留：文件名（`1.md`）、列表序号（`1.` `2、`）、纯分隔线/表格残留。
const FILE_NAME = /[\w.-]+\.(md|txt|xlsx|xls|csv|json|pdf|docx?|png|jpe?g)\b/gi;
const LIST_MARKER = /\d{1,2}\s*[.、)）](?!\d)\s*/g;
const SEPARATOR_ONLY = /^[\s\-—–·|+*_/\\]+$/;

/** 片段清理：去文件名/列表序号/分隔线，压空白；纯分隔残留返回 '' */
function cleanClause(clause) {
  const t = String(clause || '')
    .replace(FILE_NAME, ' ')
    .replace(LIST_MARKER, '')
    .replace(/\s+([。！？…，,、；;：:])/g, '$1') // 全角标点前的多余空格（加粗残留）
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || SEPARATOR_ONLY.test(t)) return '';
  return t;
}

/** 片段过长时截到第一个"数字+单位"附近，避免把整段叙述念完 */
function shortenClause(clause) {
  const cut = (text) =>
    text
      .replace(/^[，,。；;、：:\s]+/, '')
      .replace(/[，,、：:；;\s]+$/, '') // 收尾不留悬挂标点（"…1 个文件 ，"这种）；句末句号保留
      .trim();
  if (clause.length <= MAX_CLAUSE_CHARS) return cut(clause);
  const m = clause.match(BUSINESS_UNIT);
  const end = m ? Math.min(clause.length, m.index + m[0].length + 6) : MAX_CLAUSE_CHARS;
  const start = Math.max(0, end - MAX_CLAUSE_CHARS);
  return cut(clause.slice(start, end));
}

/** 把片段拼成播报文本：按顺序累加到长度上限，片段间补逗号，收尾补句号 */
function joinClauses(clauses) {
  let out = '';
  for (const clause of clauses) {
    const piece = shortenClause(clause);
    if (!piece) continue;
    if (out && out.length + piece.length + 1 > MAX_SPEECH_CHARS) break;
    const needComma = out && !/[。！？…]$/.test(out); // 上一片段已收句就不再加逗号
    out += (needComma ? '，' : '') + piece;
  }
  if (!out) return '';
  return /[。！？…]$/.test(out) ? out : out + '。'; // 收尾给 TTS 一个停顿
}

/**
 * 拆出两类播报片段：
 *   withUnit —— 带业务单位的数字片段（要念的正文）；
 *   plain    —— 只有数字、没单位的片段（表格行/ID/日期/序号）。
 * 调用方（stream.js）按**整段回复**决定：有 withUnit 就只念 withUnit；
 * 整段都没有 withUnit 时才拿 plain 兜底——否则表格里的 kb_xxx、2026-09-29 会被逐句念出来。
 */
function speechParts(text, mode) {
  const clean = stripMarkup(text);
  if (!clean) return { withUnit: '', plain: '' };
  if (normalizeMode(mode) === 'full') return { withUnit: clean, plain: '' };
  const clauses = splitClauses(clean)
    .map(cleanClause)
    .filter((c) => c && NUMBER.test(c) && !STYLE_NOISE.test(c));
  return {
    withUnit: joinClauses(clauses.filter((c) => BUSINESS_UNIT.test(c))),
    plain: joinClauses(clauses.filter((c) => !BUSINESS_UNIT.test(c))),
  };
}

/** 按标点把文本切成片段（每段带自己的尾标点） */
function splitClauses(text) {
  const out = [];
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    cur += ch;
    if (!CLAUSE_BOUNDARY.test(ch)) continue;
    // 英文逗号夹在数字中间是千分位（12,345），不是片段边界——断了会把数字切成两半
    // （曾把「库存总量为 12,345 件」念成「345 件」）。
    const prev = text[i - 1] || '';
    const next = text[i + 1] || '';
    if (ch === ',' && /\d/.test(prev) && /\d/.test(next)) continue;
    out.push(cur);
    cur = '';
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** 文本是否含数字（全角数字也算） */
function hasNumber(text) {
  return NUMBER.test(String(text || ''));
}

/**
 * 显示文本 → 播报文本。
 * @param {string} text 一句（或整段）显示文本
 * @param {string} [mode] 'key-numbers' | 'full'，缺省/非法值按 'key-numbers'
 * @returns {string} 播报文本；精简模式下该句不含数字时返回 ''（调用方据此跳过该句 TTS）
 */
/** 单句场景（含单测）：优先带单位的片段，没有才退回纯数字片段 */
function toSpeechText(text, mode) {
  const { withUnit, plain } = speechParts(text, mode);
  return withUnit || plain;
}

// ==================== 播报文本改写（单独 LLM 链路） ====================
// 语音播报单独走一条 LLM：给它"数字人播报员"的角色 + 硬约束（不念表格/代码/Markdown/编号），
// 让它把主链路的完整回答改写成一句口语播报。对话框仍然显示主链路的完整回答（delta/replyText 不变）。
// 提示词可用 config.speech.summary.system 覆盖；用户内容里带原问题，便于它判断哪些数字是关键。
const DEFAULT_SUMMARY_SYSTEM = [
  '你是仓储数据大屏上的数字人播报员，正在用语音跟现场同事说话。',
  '把给你的这段系统回答改写成一句口语播报，要求：',
  '1) 只说用户要的关键数字和结论，20~50 个字，最多两句；',
  '2) 绝对不要念表格、字段名罗列、Markdown 标记（#、*、|）、代码、链接、编号列表；',
  '3) 像跟同事说话一样自然，先给结论；数据查不到就直说“暂时查不到”；',
  '4) 只输出要念的那句话，不要解释、不要前后缀、不要引号。',
].join('\n');

/**
 * 组播报改写的提示词。
 * @param {string} fullText 主链路完整回答（显示文本）
 * @param {string} [question] 用户原问题
 * @param {{system?: string}} [opts] system 可覆盖默认角色提示
 * @returns {{system: string, user: string}}
 */
function buildSummaryPrompt(fullText, question, opts = {}) {
  const system = String((opts && opts.system) || '').trim() || DEFAULT_SUMMARY_SYSTEM;
  const user = [
    question ? '用户问题：' + String(question).trim() : '',
    '系统完整回答（供你改写，不要照抄）：',
    String(fullText || '').trim(),
    '',
    '请只输出要播报的口语文本：',
  ]
    .filter((line) => line !== '')
    .join('\n');
  return { system, user };
}

module.exports = {
  DEFAULT_SUMMARY_SYSTEM,
  buildSummaryPrompt,
  DEFAULT_MODE,
  normalizeMode,
  toSpeechText,
  hasNumber,
  stripMarkup,
  speechParts,
};
