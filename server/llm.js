'use strict';

const config = require('./config');
const { Timing } = require('./timing');

// LLM:文字 → 回复。根据 provider 分流:
// - openai-compatible: DeepSeek(OpenAI 兼容,context 是消息历史数组)
// - yuxi-chat        : 语析 openapi chat(SSE 流式累加,context 是 thread_id)
// context 由 index.js 在会话表中维护,实现多轮记忆。

async function ask(query, context) {
  if (config.llm.provider === 'openai-compatible') {
    return askOpenAI(query, context);
  }
  return askYuxiChat(query, context);
}

// ---------- DeepSeek / OpenAI 兼容 ----------
async function askOpenAI(query, messages) {
  if (!config.llm.apiKey) {
    throw new Error('DeepSeek API key 未配置(server/config/online.json 里 llm.apiKey 留空)');
  }
  const history = Array.isArray(messages) ? messages : [];
  const nextMessages = [...history, { role: 'user', content: query }];

  const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.llm.apiKey}`,
    },
    body: JSON.stringify({
      model: config.llm.model,
      messages: nextMessages,
    }),
    signal: AbortSignal.timeout(config.llm.timeoutMs),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`DeepSeek 请求失败: HTTP ${res.status} ${detail.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = (data.choices?.[0]?.message?.content || '').trim();
  if (!text) {
    throw new Error('DeepSeek 返回内容为空');
  }

  // 追加本轮问答,保留上下文
  nextMessages.push({ role: 'assistant', content: text });
  return { text, context: nextMessages };
}

// ---------- 语析 openapi chat(SSE 流式)----------
// POST {url}/yuxi/openapi/v1/agents/{agentId}/chat,body { input, user, stream:true }。
// 返回 SSE:每行 data: 是独立 JSON,payload.items[].stream_event.type=message_delta
// 的 content 是增量文本,逐条累加成完整回复;thread_id 由事件带出,存作多轮上下文。
async function askYuxiChat(query, threadId) {
  const t = new Timing('yuxi-chat');
  const res = await fetch(
    `${config.llm.url}/yuxi/openapi/v1/agents/${config.llm.agentId}/chat`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.llm.apiKey}` },
      body: JSON.stringify({
        input: query,
        user: config.llm.userId || 'external-user-001',
        stream: true,
        ...(threadId ? { thread_id: threadId } : {}),
      }),
      signal: AbortSignal.timeout(config.llm.timeoutMs || 90000),
    },
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`语析 chat 请求失败: HTTP ${res.status} ${detail.slice(0, 300)}`);
  }

  const { text, threadId: nextThread } = await readYuxiSse(res.body, () => t.mark('首块'));
  t.mark('完成');
  t.log();
  const reply = text.trim();
  if (!reply) {
    throw new Error('语析 chat 流式返回无内容');
  }
  return { text: reply, context: nextThread || threadId };
}

// 逐行读 SSE:data: 行是独立 JSON,取 message_delta 增量累加,并抓 thread_id。
async function readYuxiSse(body, onFirstDelta) {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  let text = '';
  let threadId = null;
  let firstDelta = true;

  function handleLine(line) {
    if (!line.startsWith('data:')) return;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') return;
    let evt;
    try { evt = JSON.parse(raw); } catch { return; }
    if (!threadId && evt.thread_id) threadId = evt.thread_id;
    const items = evt.payload?.items;
    if (!Array.isArray(items)) return;
    for (const it of items) {
      const se = it.stream_event;
      if (se?.type === 'message_delta' && typeof se.content === 'string') {
        if (firstDelta) { firstDelta = false; onFirstDelta?.(); }
        text += se.content;
      }
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        handleLine(line);
      }
    }
  } catch (err) {
    // 超时/中断:已攒到部分文本就返回,否则抛错
    if (text.trim()) return { text, threadId };
    throw err;
  }
  if (buffer.startsWith('data:')) handleLine(buffer);

  return { text, threadId };
}

module.exports = { ask };
