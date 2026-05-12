import logger from '../utils/logger.js';

const DEFAULT_MODEL = 'text-embedding-004';
const BATCH_SIZE = 32;
const MAX_CHARS_PER_TEXT = 9000;
const TIMEOUT_MS = Number(
  process.env.GEMINI_EMBEDDING_TIMEOUT_MS || process.env.EMBEDDING_SERVICE_TIMEOUT_MS || 90_000,
);

/** Last successful embedding metadata (stored on Resource) */
let _lastEmbeddingMeta = { model: '', dimensions: 0 };

function requestTimeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(new Error('GEMINI_EMBEDDING_TIMEOUT')), ms);
  return ctrl.signal;
}

function normalizeModelId(raw) {
  const m = (raw || DEFAULT_MODEL).trim();
  if (!m) return `models/${DEFAULT_MODEL}`;
  if (m.startsWith('models/')) return m;
  return `models/${m}`;
}

function parseValues(row) {
  if (!row) return null;
  if (Array.isArray(row.values)) return row.values;
  if (row.embedding && Array.isArray(row.embedding.values)) return row.embedding.values;
  return null;
}

/**
 * Gemini embeddings enabled when a key is present and embeddings are not explicitly disabled.
 */
export const isEmbeddingServiceEnabled = () => {
  if (process.env.EMBEDDING_SERVICE_DISABLED === 'true') return false;
  return Boolean(process.env.GEMINI_API_KEY?.trim());
};

/** @deprecated alias */
export const isEmbeddingConfigured = () => isEmbeddingServiceEnabled();

/**
 * Single embed (fallback / small batches).
 * @see https://ai.google.dev/api/rest/v1beta/models/embedContent
 */
async function geminiEmbedContent(apiKey, modelPath, text, taskType) {
  const url = `https://generativelanguage.googleapis.com/v1beta/${modelPath}:embedContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: { parts: [{ text: String(text).slice(0, MAX_CHARS_PER_TEXT) }] },
      taskType,
    }),
    signal: requestTimeoutSignal(TIMEOUT_MS),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Gemini embedContent ${res.status}: ${t.slice(0, 400)}`);
  }
  const data = await res.json();
  const values = parseValues(data.embedding) || parseValues(data);
  if (!values?.length) throw new Error('Gemini embedContent: empty embedding');
  return values;
}

/**
 * Batch embed when supported; otherwise sequential single calls.
 * @see https://ai.google.dev/api/rest/v1beta/models/batchEmbedContents
 */
async function geminiBatchEmbed(apiKey, modelPath, texts, taskType) {
  const requests = texts.map((text) => ({
    model: modelPath,
    content: { parts: [{ text: String(text).slice(0, MAX_CHARS_PER_TEXT) }] },
    taskType,
  }));

  const url = `https://generativelanguage.googleapis.com/v1beta/${modelPath}:batchEmbedContents?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
    signal: requestTimeoutSignal(TIMEOUT_MS),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    logger.warn(`[embeddingService] batchEmbedContents ${res.status}, falling back to sequential: ${t.slice(0, 200)}`);
    const out = [];
    for (const tx of texts) {
      out.push(await geminiEmbedContent(apiKey, modelPath, tx, taskType));
    }
    return out;
  }

  const data = await res.json();
  const embList = data.embeddings;
  if (!Array.isArray(embList) || embList.length !== texts.length) {
    logger.warn('[embeddingService] batch response mismatch; falling back to sequential');
    const out = [];
    for (const tx of texts) {
      out.push(await geminiEmbedContent(apiKey, modelPath, tx, taskType));
    }
    return out;
  }

  const rows = embList.map((row) => parseValues(row)).filter(Boolean);
  if (rows.length !== texts.length) {
    const out = [];
    for (const tx of texts) {
      out.push(await geminiEmbedContent(apiKey, modelPath, tx, taskType));
    }
    return out;
  }
  return rows;
}

/**
 * @param {string[]} inputs
 * @param {{ taskType?: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY' | 'SEMANTIC_SIMILARITY' }} [opts]
 * @returns {Promise<{ embeddings: number[][], model: string, dimensions: number } | null>}
 */
export const embedTexts = async (inputs, opts = {}) => {
  if (!inputs?.length) return null;
  if (!isEmbeddingServiceEnabled()) return null;

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) return null;
  const modelPath = normalizeModelId(process.env.GEMINI_EMBEDDING_MODEL);
  const taskType = opts.taskType || 'RETRIEVAL_DOCUMENT';

  const all = [];
  try {
    for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
      const batch = inputs.slice(i, i + BATCH_SIZE);
      const vectors = await geminiBatchEmbed(apiKey, modelPath, batch, taskType);
      all.push(...vectors);
    }
  } catch (e) {
    logger.warn(`[embeddingService] Gemini embeddings failed: ${e.message}`);
    return null;
  }

  if (all.length !== inputs.length) {
    logger.warn(`[embeddingService] Gemini returned ${all.length}/${inputs.length} vectors`);
    return null;
  }

  const dimensions = all[0]?.length || 0;
  const shortName = modelPath.replace(/^models\//, '');
  _lastEmbeddingMeta = { model: `gemini:${shortName}`, dimensions };
  return {
    embeddings: all,
    model: _lastEmbeddingMeta.model,
    dimensions,
  };
};

/** @deprecated use embedTexts — returns matrix only */
export const embedTextsOpenAI = async (inputs, opts) => {
  const pack = await embedTexts(inputs, opts);
  return pack?.embeddings ?? null;
};

export const getEmbeddingModelLabel = () => _lastEmbeddingMeta.model
  || (isEmbeddingServiceEnabled() ? `gemini:${process.env.GEMINI_EMBEDDING_MODEL || DEFAULT_MODEL}` : 'disabled');
