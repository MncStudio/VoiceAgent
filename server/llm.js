'use strict';

const config = require('./config');

// LLM:文字 → 回复。根据 profile 分流:
// - local  : 语析 agent/runs(异步三步,context 是 threadId)
// - online : DeepSeek(OpenAI 兼容,context 是消息历史数组)
// context 由 index.js 在会话表中维护,实现多轮记忆。

async function ask(query, context) {
  if (config.llm.provider === 'openai-compatible') {
    return askOpenAI(query, context);
  }
  return askYuxi(query, context);
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

// ---------- 语析 agent/runs ----------
function authHeaders() {
  return { Authorization: `Bearer ${config.llm.apiKey}`, 'Content-Type': 'application/json' };
}

async function createThread() {
  const res = await fetch(`${config.llm.url}/api/chat/thread`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ agent_id: config.llm.agentId }),
    signal: AbortSignal.timeout(config.llm.requestTimeoutMs),
  });
  if (!res.ok) {
    throw new Error(`创建线程失败: HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.id;
}

async function startRun(query, threadId) {
  const res = await fetch(`${config.llm.url}/api/agent/runs`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ query, agent_slug: config.llm.agentSlug, thread_id: threadId }),
    signal: AbortSignal.timeout(config.llm.requestTimeoutMs),
  });
  if (!res.ok) {
    throw new Error(`发起 agent run 失败: HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.run_id;
}

async function pollRun(runId) {
  const deadline = Date.now() + config.llm.pollTimeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${config.llm.url}/api/agent/runs/${runId}`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(config.llm.requestTimeoutMs),
    });
    if (!res.ok) {
      throw new Error(`查询 run 状态失败: HTTP ${res.status}`);
    }
    const data = await res.json();
    const status = data.run?.status;
    if (status === 'completed') {
      return;
    }
    if (status === 'failed' || status === 'error' || status === 'cancelled') {
      throw new Error(`agent run 结束于异常状态: ${status}`);
    }
    await new Promise((r) => setTimeout(r, config.llm.pollIntervalMs));
  }
  throw new Error(`agent run 轮询超时(${config.llm.pollTimeoutMs}ms)`);
}

async function getResult(runId) {
  const res = await fetch(`${config.llm.url}/api/agent/runs/${runId}/result`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(config.llm.requestTimeoutMs),
  });
  if (!res.ok) {
    throw new Error(`获取 run 结果失败: HTTP ${res.status}`);
  }
  const data = await res.json();
  const text = (data.output || '').trim();
  if (!text) {
    throw new Error('agent 返回内容为空');
  }
  return text;
}

async function askYuxi(query, threadId) {
  if (!threadId) {
    threadId = await createThread();
  }
  const runId = await startRun(query, threadId);
  await pollRun(runId);
  const text = await getResult(runId);
  return { text, context: threadId };
}

module.exports = { ask };
