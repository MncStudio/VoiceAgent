'use strict';

const llm = require('./llm');
const { Timing } = require('./timing');

// 流式问答的 LLM 部分:调 llm.askStream,onDelta(增量文本)透传,供 /api/chat_stream 逐句喂 TTS。
// 无多轮记忆:context 恒传空 → yuxi 端每次新建线程 / openai 每次空历史,等同单轮独立对话。
async function askStream(userText, onDelta, signal) {
  const t = new Timing('turnStream');
  const { text: replyText } = await llm.askStream(userText, undefined, onDelta, signal);
  t.mark('LLM');
  t.log();
  return { replyText, userText };
}

module.exports = { askStream };
