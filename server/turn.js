'use strict';

const llm = require('./llm');
const { Timing } = require('./timing');

// 会话表:sessionId → context(语析存 threadId,DeepSeek 存消息历史)。
// 语音(POST /api/chat)、文字(POST /api/chat_text)、唤醒(wake WS)三路共用,
// 因此三路多轮记忆互通。单实例内存够用;多实例部署时需换 redis/数据库。
const sessions = new Map();

// 一轮问答的 LLM 部分:文字 → 回复文本。音频不再在这里合成,
// 前端拿到 replyText 后经 /api/tts WS 流式合成并播放(边生成边播)。
async function ask(userText, sessionId) {
  const t = new Timing(`turn[${sessionId || '-'}]`);
  const context = sessions.get(sessionId);
  const { text: replyText, context: newContext } = await llm.ask(userText, context);
  t.mark('LLM');
  if (sessionId) {
    sessions.set(sessionId, newContext);
  }
  t.log();
  return { replyText, userText };
}

module.exports = { ask };
