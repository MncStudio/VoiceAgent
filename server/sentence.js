'use strict';

// 断句器:把 LLM 流式增量文本攒起来,按句子边界切分,供「逐句 TTS 流式合成」。
// 关键:LLM 的增量 token 不能直接喂 TTS(单 token 无断句、合成出来语音断续、停顿乱),
// 这里攒到句子边界才切一句;切出的句子含句末标点一起送 TTS(CosyVoice 用标点调韵律)。
// 纯逻辑无 IO,可单测。

const TERMINATORS = new Set(['。', '！', '？', '…']);

class SentenceBuffer {
  constructor(opts = {}) {
    // 无终止符时按长度强制切,避免一直攒不出句(低延迟兜底;越短句越多、句间空档越大)。
    this.maxLen = opts.maxLen || 50;
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
      if (TERMINATORS.has(ch) || ch === '\n') {
        // 句末标点保留进句子;换行是边界,不留进正文。
        let sent = ch === '\n' ? b.slice(start, i) : b.slice(start, i) + ch;
        sent = sent.replace(/\s+$/, '').trim();
        if (sent) out.push(sent);
        start = i + 1;
        // 跳过连续终止符(……、!!!、换行),避免切出空句。
        while (start < b.length && (TERMINATORS.has(b[start]) || b[start] === '\n')) start++;
        i = start - 1;
      } else if (i - start + 1 >= this.maxLen) {
        // 无终止符但攒够了长度:强制切(可能切半句,为低延迟兜底)。
        const forced = b.slice(start, i + 1).trim();
        if (forced) out.push(forced);
        start = i + 1;
      }
    }
    this.buf = b.slice(start);
    return out;
  }

  // LLM 流结束时,返回残余半句(若有),并把缓冲清空。之后应 reset。
  flush() {
    const s = this.buf.trim();
    this.buf = '';
    return s || null;
  }

  // 打断/复位。
  reset() {
    this.buf = '';
  }
}

module.exports = { SentenceBuffer };
