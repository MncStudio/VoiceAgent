'use strict';

const llm = require('./llm');
const { Timing } = require('./timing');

// 会话表:sessionId → context(语析存 threadId,DeepSeek 存消息历史)。
// 语音(POST /api/chat)、文字(/api/chat_stream)、唤醒(wake WS 带问题)三路共用,
// 因此三路多轮记忆互通。单实例内存够用;多实例部署时需换 redis/数据库。
const sessions = new Map();

// 流式问答的 LLM 部分:调 llm.askStream,onDelta(增量文本)透传,供 /api/chat_stream 逐句喂 TTS。
// 仅当 llm.askStream 正常 resolve(未被外部打断)时写回多轮记忆——被打断的半句不污染历史;
// 超时但已有部分文本(外部 signal 未 abort)仍算正常生成,会写回。
async function askStream(userText, sessionId, onDelta, signal) {
  const t = new Timing(`turnStream[${sessionId || '-'}]`);
  const context = sessions.get(sessionId);
  const { text: replyText, context: newContext } = await llm.askStream(userText, context, onDelta, signal);
  t.mark('LLM');
  t.log();
  if (sessionId) {
    sessions.set(sessionId, newContext);
  }
  return { replyText, userText };
}

module.exports = { askStream };
