'use strict';

const llm = require('./llm');
const { Timing } = require('./timing');

// 多轮记忆:仅对"provider 自带会话 id"生效——yuxi 返回 thread_id(轻量引用),存到会话表,下次接同
// sessionId 时传回续接;openai-compatible 无会话 id(靠本地消息数组),不走记忆,每次空历史单轮。
// 条目带最后活动时间戳:超过 TTL 未活动即淘汰,防止会话表只增不减长期内存缓涨。
const sessions = new Map(); // sessionId → { threadId, ts }
const TTL_MS = 24 * 60 * 60 * 1000; // 24h 无活动淘汰
const SWEEP_MS = 30 * 60 * 1000;

function prune() {
  const now = Date.now();
  for (const [k, v] of sessions) {
    if (now - v.ts > TTL_MS) sessions.delete(k);
  }
}
const sweep = setInterval(prune, SWEEP_MS);
if (sweep.unref) sweep.unref(); // 不阻止进程退出

async function askStream(userText, sessionId, onDelta, signal) {
  const t = new Timing(`turnStream[${sessionId || '-'}]`);
  const entry = sessionId ? sessions.get(sessionId) : undefined;
  const context = entry ? entry.threadId : undefined;
  const { text: replyText, context: newContext } = await llm.askStream(userText, context, onDelta, signal);
  t.mark('LLM');
  t.log();
  // 仅当 provider 返回了会话引用(如 yuxi 的 thread_id)且本 ID 有效才续存;openai 不提供 → 不存。
  if (sessionId && newContext) {
    sessions.set(sessionId, { threadId: newContext, ts: Date.now() });
    if (sessions.size > 2000) prune(); // 超大时提前清一轮
  }
  return { replyText, userText };
}

module.exports = { askStream };
