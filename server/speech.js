'use strict';

// 「播报文本」与「显示文本」第一次在这里分开：
//   显示文本 = LLM 完整回复 —— `/api/chat_stream` 的 delta 与 done.replyText，前端弹窗/字幕逐字显示，不截断；
//   播报文本 = 只挑出含数字的短句片段 —— 大屏业务答句里"数字"才是用户要听的结果，
//              完整念一遍又慢又啰嗦（"库存总量为 12,345 件，其中原材料 5,678 件，此外建议关注临期物料"
//              → 只念"库存总量为 12,345 件，其中原材料 5,678 件"）。
// done.speechText 回带实际播报文本（与推给前端的 PCM 一致），便于对账/排查。
//
// 模式（config.speech.mode）：
//   'key-numbers'（默认）：按标点切片，只保留含数字的片段；整段回复一个数字都没有时，
//                          由 stream.js 兜底播完整回复，避免"有问无声"。
//   'full'               ：不精简，播报 = 完整回复（等于关掉本能力，便于回滚/对比）。
//
// 纯逻辑无 IO，可单测（test/speech.test.js）。

const DEFAULT_MODE = 'key-numbers';
const MODES = new Set(['key-numbers', 'full']);

/** 归一化模式：未配置/写错都落回默认值 */
function normalizeMode(mode) {
  return MODES.has(mode) ? mode : DEFAULT_MODE;
}

// LLM 回复常带 Markdown 排版（标题、加粗、表格竖线、代码、链接），念出来是噪音，先清掉再挑片段。
// 空白（含换行）统一压成单个空格：换行是排版，不该在播报里当停顿。
function stripMarkup(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')        // 代码块
    .replace(/`([^`]*)`/g, '$1')            // 行内代码
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接/图片语法，保留可见文字
    .replace(/[*_#>|]+/g, ' ')              // 加粗/斜体/标题/引用/表格竖线
    .replace(/\s+/g, ' ')
    .trim();
}

// 片段边界：中英文逗号/分号/顿号/冒号 + 句末标点。切分保留标点本身
// （标点决定 TTS 的停顿与韵律，丢掉会把两句黏成一句）。
const CLAUSE_BOUNDARY = /[，,；;、：:。！？!?…]/;
const NUMBER = /[0-9０-９]/;

/** 按标点把文本切成片段（每段带自己的尾标点） */
function splitClauses(text) {
  const out = [];
  let cur = '';
  for (const ch of text) {
    cur += ch;
    if (CLAUSE_BOUNDARY.test(ch)) {
      out.push(cur);
      cur = '';
    }
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
function toSpeechText(text, mode) {
  const clean = stripMarkup(text);
  if (!clean) return '';
  if (normalizeMode(mode) === 'full') return clean;
  const kept = splitClauses(clean).filter((clause) => NUMBER.test(clause));
  return kept.join('').replace(/\s+/g, ' ').trim();
}

module.exports = { DEFAULT_MODE, normalizeMode, toSpeechText, hasNumber, stripMarkup };
