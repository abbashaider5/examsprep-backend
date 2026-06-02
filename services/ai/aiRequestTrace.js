import { getRequestContext, patchRequestContext } from '../../utils/requestContext.js';

let callSeq = 0;

function nextId() {
  callSeq += 1;
  return `ai-${Date.now()}-${callSeq}`;
}

/**
 * @param {{ operation: string, model?: string, purpose?: string, promptChars?: number }} meta
 */
export function startAiCall(meta) {
  const id = nextId();
  const startedAt = Date.now();
  const entry = {
    id,
    operation: meta.operation || 'chat_completion',
    service: 'ai_chat_completion',
    purpose: meta.purpose || meta.operation || 'generation',
    model: meta.model || '',
    promptChars: meta.promptChars || 0,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: null,
    tokensUsed: null,
    promptTokens: null,
    completionTokens: null,
    cacheHit: false,
  };

  const ctx = getRequestContext();
  if (ctx) {
    if (!ctx.aiTrace) ctx.aiTrace = { calls: [], cacheHits: 0, cacheMisses: 0 };
    ctx.aiTrace.calls.push(entry);
  }
  return { id, startedAt, entry };
}

export function recordCacheHit(kind = 'curriculum_concepts') {
  const ctx = getRequestContext();
  if (!ctx?.aiTrace) return;
  ctx.aiTrace.cacheHits = (ctx.aiTrace.cacheHits || 0) + 1;
  ctx.aiTrace.calls.push({
    id: nextId(),
    operation: kind,
    service: 'cache',
    purpose: `Reuse cached ${kind}`,
    cacheHit: true,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    tokensUsed: 0,
  });
}

export function recordCacheMiss(kind = 'curriculum_concepts') {
  const ctx = getRequestContext();
  if (!ctx?.aiTrace) return;
  ctx.aiTrace.cacheMisses = (ctx.aiTrace.cacheMisses || 0) + 1;
}

/**
 * @param {{ id: string, startedAt: number, entry: object }} traceRef
 * @param {object} completion
 */
export function finishAiCall(traceRef, completion) {
  if (!traceRef?.entry) return;
  const usage = completion?.usage || {};
  traceRef.entry.durationMs = Date.now() - traceRef.startedAt;
  traceRef.entry.promptTokens = usage.prompt_tokens ?? null;
  traceRef.entry.completionTokens = usage.completion_tokens ?? null;
  const totalTokens = usage.total_tokens;
  const computedTokens = totalTokens ?? ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0));
  traceRef.entry.tokensUsed = Number.isFinite(computedTokens) ? computedTokens : null;
}

export function getAiRequestReport() {
  const ctx = getRequestContext();
  if (!ctx?.aiTrace) {
    return {
      totalAiCalls: 0,
      totalTokensUsed: 0,
      totalAiTimeMs: 0,
      cacheHits: 0,
      cacheMisses: 0,
      calls: [],
    };
  }

  const calls = ctx.aiTrace.calls.filter((c) => c.service !== 'cache');
  const providerCalls = calls.filter((c) => !c.cacheHit);
  const totalTokensUsed = providerCalls.reduce((s, c) => s + (c.tokensUsed || 0), 0);
  const totalAiTimeMs = providerCalls.reduce((s, c) => s + (c.durationMs || 0), 0);

  return {
    totalAiCalls: providerCalls.length,
    totalTokensUsed,
    totalAiTimeMs,
    cacheHits: ctx.aiTrace.cacheHits || 0,
    cacheMisses: ctx.aiTrace.cacheMisses || 0,
    calls: ctx.aiTrace.calls,
  };
}

export function initAiTraceForRequest() {
  patchRequestContext({ aiTrace: { calls: [], cacheHits: 0, cacheMisses: 0 } });
}

export function formatAiTraceTree(report) {
  const lines = ['Exam Request'];
  for (let i = 0; i < report.calls.length; i += 1) {
    const c = report.calls[i];
    const prefix = i === report.calls.length - 1 ? '└──' : '├──';
    const tok = c.cacheHit ? 'cache hit' : `${c.tokensUsed ?? '?'} tokens`;
    const dur = c.durationMs != null ? `${c.durationMs}ms` : '—';
    lines.push(`${prefix} AI Call #${i + 1}: [${c.operation}] ${c.purpose} — ${tok}, ${dur}`);
  }
  lines.push(`Summary: ${report.totalAiCalls} provider call(s), ${report.totalTokensUsed} tokens, ${report.totalAiTimeMs}ms, cache hits ${report.cacheHits}`);
  return lines.join('\n');
}
