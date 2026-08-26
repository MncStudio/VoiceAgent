'use strict';

const llm = require('./llm');
const { Timing } = require('./timing');

// 多轮记忆:仅对"provider 自带会话 id"生效——yuxi 返回 thread_id(轻量引用),存到会话表,下次接同
// sessionId 时传回续接;openai-compatible 无会话 id(靠本地消息数组),不走记忆,每次空历史单轮。
const sessions = new Map(); // sessionId → context(yuxi 的 thread_id)

async function askStream(userText, sessionId, onDelta, signal) {
  const t = new Timing(`turnStream[${sessionId || '-'}]`);
  const context = sessionId ? sessions.get(sessionId) : undefined;
  const { text: replyText, context: newContext } = await llm.askStream(userText, context, onDelta, signal);
  t.mark('LLM');
  t.log();
  // 仅当 provider 返回了会话引用(如 yuxi 的 thread_id)且本 ID 有效才续存;openai 不提供 → 不存。
  if (sessionId && newContext) sessions.set(sessionId, newContext);
  return { replyText, userText };
}

module.exports = { askStream };
