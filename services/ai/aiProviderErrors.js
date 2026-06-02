import { PROVIDERS } from './aiProviderRegistry.js';

const PROVIDER_NAME_RE = /\b(groq|openai|gemini|claude|anthropic|openrouter)\b/gi;
const MODEL_RE = /\b(llama|gpt-|gemini|claude|meta-llama)[^\s,.)]*/gi;
const ORG_RE = /\borg[_-]?[a-z0-9]{8,}\b/gi;

/**
 * @typedef {object} NormalizedAiError
 * @property {string} provider
 * @property {string} providerDisplayName
 * @property {string} errorType
 * @property {string} errorCode
 * @property {string} message
 * @property {string} model
 * @property {number|null} tokensUsed
 * @property {number|null} tokensLimit
 * @property {number|null} httpStatus
 * @property {string} rawResponse
 * @property {string} stackTrace
 * @property {string} operation
 * @property {string} environment
 * @property {string} timestamp
 */

function pickErrorBody(err) {
  if (err?.error) return err.error;
  if (err?.response?.data?.error) return err.response.data.error;
  if (err?.response?.data) return err.response.data;
  return err;
}

function classifyMessage(msg = '') {
  const m = String(msg).toLowerCase();
  if (/rate limit|too many requests|429/.test(m)) {
    return { errorType: 'Rate Limit Exceeded', errorCode: 'rate_limit_exceeded' };
  }
  if (/token|context length|max_tokens|quota|insufficient_quota|billing/.test(m)) {
    return { errorType: 'Token Limit Exceeded', errorCode: 'token_limit_exceeded' };
  }
  if (/timeout|timed out|etimedout|econnaborted/.test(m)) {
    return { errorType: 'Timeout', errorCode: 'timeout' };
  }
  if (/unavailable|503|502|bad gateway|overloaded|capacity/.test(m)) {
    return { errorType: 'Provider Unavailable', errorCode: 'provider_unavailable' };
  }
  if (/network|fetch failed|econnreset|enotfound|socket/.test(m)) {
    return { errorType: 'Network Error', errorCode: 'network_error' };
  }
  if (/invalid api key|authentication|unauthorized|401/.test(m)) {
    return { errorType: 'Authentication Failure', errorCode: 'auth_failure' };
  }
  return { errorType: 'AI Generation Failure', errorCode: 'ai_generation_failure' };
}

function extractTokenUsage(body, err) {
  const usage = body?.usage || err?.usage || err?.response?.data?.usage;
  if (!usage) return { tokensUsed: null, tokensLimit: null };
  const used = usage.total_tokens ?? usage.prompt_tokens ?? null;
  let limit = null;
  const hint = JSON.stringify(body || err?.message || '');
  const limitMatch = hint.match(/limit[:\s]+(\d+)/i);
  if (limitMatch) limit = Number(limitMatch[1]);
  return { tokensUsed: Number.isFinite(used) ? used : null, tokensLimit: limit };
}

function safeStringify(value) {
  try {
    if (typeof value === 'string') return value.slice(0, 12000);
    return JSON.stringify(value, null, 2).slice(0, 12000);
  } catch {
    return String(value).slice(0, 12000);
  }
}

/**
 * Normalize any provider SDK / fetch error into a consistent diagnostics object.
 * @param {unknown} err
 * @param {{ provider?: string, model?: string, operation?: string, environment?: string }} [ctx]
 * @returns {NormalizedAiError}
 */
export function normalizeProviderError(err, ctx = {}) {
  const provider = ctx.provider || 'unknown';
  const providerDef = PROVIDERS[provider];
  const providerDisplayName = providerDef?.displayName || provider;
  const body = pickErrorBody(err);
  const httpStatus = Number(err?.status || err?.statusCode || err?.response?.status) || null;
  const rawMessage = String(
    body?.message || err?.message || (typeof body === 'string' ? body : '') || 'AI provider request failed',
  );
  const codeFromBody = String(body?.code || body?.type || err?.code || '').trim();
  const classified = classifyMessage(`${rawMessage} ${codeFromBody}`);
  const { tokensUsed, tokensLimit } = extractTokenUsage(body, err);

  return {
    provider,
    providerDisplayName,
    errorType: classified.errorType,
    errorCode: codeFromBody || classified.errorCode,
    message: rawMessage,
    model: ctx.model || '',
    tokensUsed,
    tokensLimit,
    httpStatus,
    rawResponse: safeStringify(err?.response?.data ?? body ?? err),
    stackTrace: String(err?.stack || '').slice(0, 8000),
    operation: ctx.operation || '',
    environment: ctx.environment || '',
    timestamp: new Date().toISOString(),
  };
}

/** Strip provider-specific details from text shown to non-admin users. */
export function sanitizeUserFacingText(text) {
  if (!text) return '';
  let out = String(text);
  out = out.replace(PROVIDER_NAME_RE, 'AI service');
  out = out.replace(MODEL_RE, '');
  out = out.replace(ORG_RE, '');
  out = out.replace(/\b(rate limit|token limit|organization id|api key)\b/gi, '');
  return out.replace(/\s{2,}/g, ' ').trim();
}

export function isLikelyProviderError(err) {
  if (!err) return false;
  if (err.isAiServiceError || err.name === 'AiServiceError') return true;
  const status = Number(err.status || err.statusCode || err.response?.status);
  if ([401, 402, 403, 408, 429, 500, 502, 503, 504].includes(status)) return true;
  const msg = String(err.message || '').toLowerCase();
  return /rate limit|token|groq|openai|timeout|overloaded|quota|billing|fetch failed|econn/i.test(msg);
}
