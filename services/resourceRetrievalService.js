import mongoose from 'mongoose';
import ResourceChunk from '../models/ResourceChunk.js';
import logger from '../utils/logger.js';
import { embedTexts } from './embeddingService.js';

const cosine = (a, b) => {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d > 1e-12 ? dot / d : 0;
};

/** Cheap lexical score when embeddings unavailable */
const lexicalScore = (chunkText, keywords) => {
  if (!keywords.length) return 0;
  const lower = chunkText.toLowerCase();
  let hit = 0;
  for (const kw of keywords) {
    if (kw.length > 2 && lower.includes(kw.toLowerCase())) hit += 1;
  }
  return hit / keywords.length;
};

function packChunks(rows, maxChars, mode) {
  let total = 0;
  const parts = [];
  const refs = [];
  for (const row of rows) {
    const header = row.sectionTitle ? `[Section: ${row.sectionTitle}]\n` : '';
    const block = `${header}${row.text}`.trim();
    if (!block) continue;
    const piece = `\n---\n${block}`;
    if (total + piece.length > maxChars) break;
    parts.push(piece);
    total += piece.length;
    refs.push({ chunkIndex: row.chunkIndex, sectionTitle: row.sectionTitle || '' });
  }
  return {
    context: parts.join('').trim(),
    chunkRefs: refs,
    mode,
  };
}

/**
 * Atlas Vector Search (optional). Requires vector index on `ResourceChunk.embedding`.
 * Env: MONGODB_VECTOR_INDEX_NAME, MONGODB_VECTOR_INDEX_PATH (default embedding)
 */
export const retrieveWithAtlasVectorSearch = async (resourceId, queryVector, limit = 20) => {
  const indexName = process.env.MONGODB_VECTOR_INDEX_NAME?.trim();
  if (!indexName || !queryVector?.length) return null;
  const path = process.env.MONGODB_VECTOR_INDEX_PATH?.trim() || 'embedding';
  const rid = typeof resourceId === 'string' ? new mongoose.Types.ObjectId(resourceId) : resourceId;
  try {
    const pipeline = [
      {
        $vectorSearch: {
          index: indexName,
          path,
          queryVector,
          numCandidates: Math.min(200, Math.max(limit * 5, 50)),
          limit,
          filter: { resource: rid },
        },
      },
      { $project: { text: 1, chunkIndex: 1, sectionTitle: 1, score: { $meta: 'vectorSearchScore' } } },
    ];
    return ResourceChunk.aggregate(pipeline);
  } catch (e) {
    logger.warn(`[resourceRetrieval] Atlas $vectorSearch unavailable: ${e.message}`);
    return null;
  }
};

/**
 * Build a retrieval query string from exam settings.
 */
export const buildRetrievalQuery = ({ subject, topics = [] }) => {
  const t = (topics || []).filter(Boolean).slice(0, 12).join(', ');
  const sub = (subject || '').trim() || 'educational material';
  return t ? `${sub}. Relevant topics: ${t}.` : `${sub}.`;
};

/**
 * @param {import('mongoose').Types.ObjectId|string} resourceId
 * @param {{ subject: string, topics?: string[], maxChars?: number, topK?: number }} opts
 */
export const retrieveGroundingContext = async (resourceId, opts) => {
  const rid = typeof resourceId === 'string' ? new mongoose.Types.ObjectId(resourceId) : resourceId;
  const maxChars = opts.maxChars ?? 14_000;
  const topK = opts.topK ?? 22;
  const topics = (opts.topics || []).map((t) => String(t).trim()).filter(Boolean);
  const keywords = [...topics, ...(opts.subject || '').split(/\s+/).filter((w) => w.length > 2)].slice(0, 24);

  const chunks = await ResourceChunk.find({ resource: rid })
    .select('text embedding chunkIndex sectionTitle')
    .sort({ chunkIndex: 1 })
    .lean();

  if (!chunks.length) return { context: '', chunkRefs: [], mode: 'none' };

  const withEmb = chunks.filter((c) => Array.isArray(c.embedding) && c.embedding.length > 0);

  if (withEmb.length) {
    try {
      const q = buildRetrievalQuery({ subject: opts.subject, topics });
      const pack = await embedTexts([q], { taskType: 'RETRIEVAL_QUERY' });
      const qVec = pack?.embeddings?.[0];
      if (qVec) {
        const atlasRows = await retrieveWithAtlasVectorSearch(rid, qVec, topK);
        if (atlasRows?.length) {
          return packChunks(atlasRows, maxChars, 'atlas');
        }
        const scored = withEmb.map((c) => {
          let s = cosine(qVec, c.embedding);
          s += lexicalScore(c.text, keywords) * 0.08;
          return { ...c, score: s };
        });
        scored.sort((a, b) => b.score - a.score);
        return packChunks(scored.slice(0, topK), maxChars, 'embedding');
      }
    } catch (e) {
      logger.warn(`[resourceRetrieval] embedding retrieval failed, falling back: ${e.message}`);
    }
  }

  /** Keyword / uniform spread fallback */
  const scored = chunks.map((c) => ({
    ...c,
    score: lexicalScore(c.text, keywords) + Math.random() * 0.001,
  }));
  scored.sort((a, b) => b.score - a.score);
  const primary = scored.slice(0, Math.min(topK, scored.length));
  const used = new Set(primary.map((c) => c.chunkIndex));
  const stride = Math.max(1, Math.floor(chunks.length / 8));
  for (let i = 0; i < chunks.length && primary.length < topK + 6; i += stride) {
    const c = chunks[i];
    if (!used.has(c.chunkIndex)) {
      primary.push({ ...c, score: 0 });
      used.add(c.chunkIndex);
    }
  }
  return packChunks(primary, maxChars, 'lexical');
};
