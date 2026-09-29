'use strict';

const crypto = require('crypto');
const config = require('./config');
const { Timing } = require('./timing');

// LLM:文字 → 回复。根据 provider 分流:
// - openai-compatible: DeepSeek(OpenAI 兼容,context 是消息历史数组)
// - yuxi-chat        : 语析 openapi chat(SSE 流式累加,context 是 thread_id)
// context 由 /api/chat_stream 经 turn.js 在会话表中维护,实现多轮记忆。
//
// 两种调用形态:
// - askStream:主问答,onDelta(增量文本)逐段回调,只在外部中断时 reject;超时但已有部分文本仍 resolve。
// - askOnce  :单轮一次性(不回调增量),给"播报文本改写"这类内部用途用——语音要单独一条 LLM 链路,
//              带上"你是数字人播报员,不要念表格/代码"的角色提示,与主问答链路分开配置(speech.summary)。
// 两者都支持按调用传 cfg(默认 config.llm),因此可以各用各的 provider/key/模型。

async function askStream(query, context, onDelta, signal, cfg = config.llm) {
  if (cfg.provider === 'openai-compatible') return askOpenAIStream(query, context, onDelta, signal, cfg);
  if (cfg.provider === 'yuxi-runs') return askYuxiRunsStream(query, context, onDelta, signal, cfg);
  return askYuxiChatStream(query, context, onDelta, signal, cfg);
}

/**
 * 单轮一次性问答(非流式语义):返回纯文本,失败抛错。
 * @param {string} text 用户内容
 * @param {{config?: object, system?: string, signal?: AbortSignal}} [opts]
 *   config 缺省用 config.llm;system 是角色/系统提示(openai-compatible 走 system 角色,
 *   yuxi 没有独立 system 位,拼在输入前面)。
 */
async function askOnce(text, opts = {}) {
  const cfg = opts.config || config.llm;
  const q = String(text || '').trim();
  if (!q) return '';
  const system = String(opts.system || '').trim();
  if (cfg.provider === 'openai-compatible') {
    const history = system ? [{ role: 'system', content: system }] : [];
    const r = await askOpenAIStream(q, history, null, opts.signal, cfg);
    return String(r.text || '').trim();
  }
  const merged = system ? system + '\n\n' + q : q;
  if (cfg.provider === 'yuxi-runs') {
    const r = await askYuxiRunsStream(merged, undefined, null, opts.signal, cfg);
    return String(r.text || '').trim();
  }
  const r = await askYuxiChatStream(merged, undefined, null, opts.signal, cfg);
  return String(r.text || '').trim();
}

// 组合「外部打断信号」与「请求超时」到一个 AbortController。
// Node engine 是 >=18,无 AbortSignal.any(Node 20),这里手动拼。
// 打断来源靠外部 signal 是否 aborted 区分:外部打断 vs 超时。
function combineSignals(externalSignal, timeoutMs) {
  const ctrl = new AbortController();
  let timeoutId;
  const onAbort = () => ctrl.abort();
  if (externalSignal) {
    if (externalSignal.aborted) ctrl.abort();
    else externalSignal.addEventListener('abort', onAbort, { once: true });
  }
  if (timeoutMs) timeoutId = setTimeout(() => ctrl.abort(), timeoutMs);
  return {
    signal: ctrl.signal,
    cleanup: () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
    },
  };
}

// ---------- DeepSeek / OpenAI 兼容 ----------
// 流式:SSE 逐 delta.content 回调,返回最终消息数组 context。
async function askOpenAIStream(query, messages, onDelta, signal, cfg = config.llm) {
  if (!cfg.apiKey) {
    throw new Error('LLM API key 未配置(llm.apiKey / speech.summary.apiKey 留空)');
  }
  const history = Array.isArray(messages) ? messages : [];
  const nextMessages = [...history, { role: 'user', content: query }];

  const combined = combineSignals(signal, cfg.timeoutMs || 120000);
  let res;
  try {
    res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({ model: cfg.model, messages: nextMessages, stream: true }),
      signal: combined.signal,
    });
  } catch (e) {
    combined.cleanup();
    throw e;
  }

  if (!res.ok) {
    combined.cleanup();
    const detail = await res.text().catch(() => '');
    throw new Error(`DeepSeek 请求失败: HTTP ${res.status} ${detail.slice(0, 200)}`);
  }

  let result;
  try {
    result = await readOpenAIStream(res.body, onDelta);
  } finally {
    combined.cleanup();
  }

  // 外部打断(用户关闭 WS):reject,不把半句当完整回复写回多轮记忆。
  if (signal?.aborted) throw new Error('已打断');

  if (!result.text.trim()) {
    // 兜底:个别兼容端点没走 SSE,返回整包 JSON(无 data: 行),尝试整包解析。
    const whole = result.raw.trim();
    if (whole) {
      try {
        const j = JSON.parse(whole);
        const c = j.choices?.[0]?.message?.content || '';
        if (typeof c === 'string' && c.length) {
          result.text = c;
          onDelta?.(c);
        }
      } catch {}
    }
  }
  if (!result.text.trim()) throw new Error('DeepSeek 返回内容为空');

  // openai-compatible 无会话 id:不返回可续 context(本地存消息数组没意义,且随会话表只增不减)。
  // 每次空历史单轮,无多轮记忆;多轮只走 yuxi 提供的 thread_id。
  return { text: result.text, context: undefined };
}

// 逐行读 OpenAI SSE:data: 行是 JSON,取 choices[].delta.content 增量。
// 流被中断(超时/打断)时吞掉,返回已攒的 text 与原始串;是否算打断由调用方按 signal 区分。
async function readOpenAIStream(body, onDelta) {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  let text = '';
  let raw = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const str = decoder.decode(value, { stream: true });
      raw += str;
      buffer += str;
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let evt;
        try { evt = JSON.parse(data); } catch { continue; }
        const delta = evt.choices?.[0]?.delta;
        // 首个 delta 常带 role 且 content 为空串,只回调非空 content(deepseek-chat 无 reasoning_content)。
        if (typeof delta?.content === 'string' && delta.content.length) {
          text += delta.content;
          onDelta?.(delta.content);
        }
      }
    }
  } catch (e) {
    // 流被中断,返回已攒的 text(有部分则上层按已生成处理)
  }
  return { text, raw };
}

// ---------- yuxi agent runs(建线程 → 建 run → 拉事件流)----------
// 流程:首次无 thread 时先 POST {url}/api/chat/thread 建对话线程拿 id(多轮记忆);
// 再 POST /api/agent/runs 创建 run(拿 run_id),GET /api/agent/runs/{run_id}/events 拉 SSE。
// SSE 里增量是 payload.items[].stream_event.type==='message_delta' 的 content,与 readYuxiSse 解析一致。
// context 存 thread_id(多轮记忆),首次由建线程生成,后续沿用。
async function askYuxiRunsStream(query, threadId, onDelta, signal, cfg = config.llm) {
  const t = new Timing('yuxi-runs');
  const combined = combineSignals(signal, cfg.timeoutMs || 120000);

  // 首次无 thread_id:先建对话线程拿 id
  let tid = threadId;
  if (!tid) {
    try {
      const cRes = await fetch(`${cfg.url}/api/chat/thread`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ agent_id: cfg.agentSlug, title: 'voiceagent' }),
        signal: combined.signal,
      });
      if (!cRes.ok) {
        const d = await cRes.text().catch(() => '');
        throw new Error(`yuxi 建线程失败: HTTP ${cRes.status} ${d.slice(0, 200)}`);
      }
      const c = await cRes.json();
      tid = c.id;
    } catch (e) {
      combined.cleanup();
      throw e;
    }
  }

  let res;
  try {
    res = await fetch(`${cfg.url}/api/agent/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        query,
        agent_slug: cfg.agentSlug,
        thread_id: tid,
        meta: { request_id: 'req-' + crypto.randomUUID(), attachment_file_ids: [] },
        image_content: null,
        model_spec: null,
        resume: null,
        created_by_run_id: null,
      }),
      signal: combined.signal,
    });
  } catch (e) {
    combined.cleanup();
    throw e;
  }
  if (!res.ok) {
    combined.cleanup();
    const detail = await res.text().catch(() => '');
    throw new Error(`yuxi runs 创建失败: HTTP ${res.status} ${detail.slice(0, 200)}`);
  }
  const run = await res.json();
  const runId = run.run_id;
  const nextThread = run.thread_id || tid;
  if (!runId) {
    combined.cleanup();
    throw new Error('yuxi runs 未返回 run_id');
  }

  let result;
  try {
    const evRes = await fetch(`${cfg.url}/api/agent/runs/${runId}/events?verbose=false`, {
      headers: { Accept: 'text/event-stream', Authorization: `Bearer ${cfg.apiKey}` },
      signal: combined.signal,
    });
    if (!evRes.ok) {
      combined.cleanup();
      const d = await evRes.text().catch(() => '');
      throw new Error(`yuxi runs 事件流失败: HTTP ${evRes.status} ${d.slice(0, 200)}`);
    }
    result = await readYuxiSse(evRes.body, onDelta);
  } finally {
    combined.cleanup();
  }
  if (signal?.aborted) throw new Error('已打断');
  t.mark('完成');
  t.log();
  const reply = result.text.trim();
  if (!reply) throw new Error('yuxi runs 流式返回无内容');
  return { text: reply, context: nextThread };
}

// ---------- 语析 openapi chat(SSE 流式)----------
// POST {url}/yuxi/openapi/v1/agents/{agentId}/chat,body { input, user, stream:true }。
// 返回 SSE:每行 data: 是独立 JSON,payload.items[].stream_event.type=message_delta
// 的 content 是增量文本,逐条累加成完整回复;thread_id 由事件带出,存作多轮上下文。
// 流式:onDelta(增量文本)逐段回调,返回 thread_id 当 context。
async function askYuxiChatStream(query, threadId, onDelta, signal, cfg = config.llm) {
  const t = new Timing('yuxi-chat');
  const combined = combineSignals(signal, cfg.timeoutMs || 90000);
  let res;
  try {
    res = await fetch(
      `${cfg.url}/yuxi/openapi/v1/agents/${cfg.agentId}/chat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          input: query,
          user: cfg.userId || 'external-user-001',
          stream: true,
          ...(threadId ? { thread_id: threadId } : {}),
        }),
        signal: combined.signal,
      },
    );
  } catch (e) {
    combined.cleanup();
    throw e;
  }

  if (!res.ok) {
    combined.cleanup();
    const detail = await res.text().catch(() => '');
    throw new Error(`语析 chat 请求失败: HTTP ${res.status} ${detail.slice(0, 300)}`);
  }

  let result;
  try {
    result = await readYuxiSse(res.body, onDelta);
  } finally {
    combined.cleanup();
  }
  if (signal?.aborted) throw new Error('已打断');
  t.mark('完成');
  t.log();
  const reply = result.text.trim();
  if (!reply) throw new Error('语析 chat 流式返回无内容');
  return { text: reply, context: result.threadId || threadId };
}

// 逐行读 SSE:data: 行是独立 JSON,取 message_delta 增量累加(可 onDelta 回调),并抓 thread_id。
// 超时/中断时已攒到部分文本就返回,否则抛错;是否算打断由调用方按 signal 区分。
async function readYuxiSse(body, onDelta) {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  let text = '';
  let threadId = null;

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
        text += se.content;
        onDelta?.(se.content);
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

module.exports = { askStream, askOnce };
