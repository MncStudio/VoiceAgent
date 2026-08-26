'use strict';

// 断句器:把 LLM 流式增量文本攒起来,按句子边界切分,供「逐句 TTS 流式合成」。
// 关键:LLM 的增量 token 不能直接喂 TTS(单 token 无断句、合成出来语音断续、停顿乱),
// 这里攒到句子边界才切一句;切出的句子含句末标点一起送 TTS(CosyVoice 用标点调韵律)。
// 纯逻辑无 IO,可单测。
//
// 两条切句约束:
// - minLen:句子不足 minLen 时暂缓(标点留句内继续攒),减少碎句→降低逐句 TTS 请求数(防限流)。
// - 有内容性过滤:切出的句子若纯标点/空白(如单独一个「！」),丢弃,不送 TTS(防 InvalidParameter)。

const TERMINATORS = new Set(['。', '！', '？', '…']);

// 是否含「非标点、非空白」的内容字符(中文/字母/数字/假名/韩文)。纯标点或空段返回 false。
function hasContent(s) {
  return /[0-9A-Za-z一-龥぀-ヿ가-힯]/.test(s);
}

class SentenceBuffer {
  constructor(opts = {}) {
    this.maxLen = opts.maxLen || 80;   // 无终止符时按长度强制切,避免一直攒不出句(低延迟兜底)
    this.minLen = opts.minLen || 5;    // 句子短于此则暂缓合并,减少碎句
    this.buf = '';
  }

  // 追加一段增量文本,返回已切出的句子数组(可多条或空)。
  push(text) {
    if (typeof text !== 'string' || !text) return [];
    this.buf += text;
    const b = this.buf;
    const out = [];
    let start = 0;
    for (let i = 0; i < b.length; i++) {
      const ch = b[i];
      if (ch === '\n') {
        // 换行是强边界:切句,但不把换行留进正文。
        const sent = b.slice(start, i).replace(/\s+$/, '').trim();
        if (sent && hasContent(sent)) out.push(sent);
        start = i + 1;
        while (start < b.length && (TERMINATORS.has(b[start]) || b[start] === '\n')) start++;
        i = start - 1;
      } else if (TERMINATORS.has(ch)) {
        if (i - start + 1 < this.minLen) {
          // 太短:先不切,标点留句内继续攒,直到长度够或遇换行/长度上限——减少碎句。
        } else {
          const sent = b.slice(start, i + 1).replace(/\s+$/, '').trim();
          if (sent && hasContent(sent)) out.push(sent);
          start = i + 1;
          while (start < b.length && (TERMINATORS.has(b[start]) || b[start] === '\n')) start++;
          i = start - 1;
        }
      } else if (i - start + 1 >= this.maxLen) {
        // 无终止符但攒够了长度:强制切(可能切半句,为低延迟兜底)。
        const forced = b.slice(start, i + 1).trim();
        if (forced && hasContent(forced)) out.push(forced);
        start = i + 1;
      }
    }
    this.buf = b.slice(start);
    return out;
  }

  // LLM 流结束:把残余(含暂缓的短句)作为尾句切出。返回数组(可能为空)。
  flush() {
    const out = [];
    const tail = this.buf.trim();
    if (tail && hasContent(tail)) out.push(tail);
    this.buf = '';
    return out;
  }

  reset() {
    this.buf = '';
  }
}

module.exports = { SentenceBuffer };
