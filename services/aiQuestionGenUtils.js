/** Default questions per Groq call — keeps JSON within output token limits. */
export const DEFAULT_QUESTION_BATCH_SIZE = Math.min(
  15,
  Math.max(5, Number(process.env.AI_QUESTION_BATCH_SIZE) || 10),
);

/**
 * @param {number} total
 * @param {number} [batchSize]
 * @returns {number[]}
 */
export function planQuestionBatches(total, batchSize = DEFAULT_QUESTION_BATCH_SIZE) {
  const n = Math.max(1, Math.floor(Number(total) || 1));
  const size = Math.max(1, Math.floor(batchSize) || DEFAULT_QUESTION_BATCH_SIZE);
  const batches = [];
  let left = n;
  while (left > 0) {
    const chunk = Math.min(size, left);
    batches.push(chunk);
    left -= chunk;
  }
  return batches;
}

export function maxTokensForMcqBatch(count) {
  const n = Math.max(1, count);
  return Math.min(8192, Math.max(2048, n * 420 + 600));
}

export function maxTokensForDescriptiveBatch(count) {
  const n = Math.max(1, count);
  return Math.min(8192, Math.max(2048, n * 680 + 600));
}

export function maxTokensForCodingBatch(count) {
  const n = Math.max(1, count);
  return Math.min(8192, Math.max(2800, n * 950 + 600));
}

export class AiGenerationError extends Error {
  /**
   * @param {string} message — safe for API clients in dev; production uses mapped copy
   * @param {{ code?: string, kind?: string, requested?: number, batchIndex?: number, totalBatches?: number }} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'AiGenerationError';
    this.statusCode = 502;
    this.publicCode = meta.code || 'AI_GENERATION_JSON_FAILED';
    this.aiKind = meta.kind || 'questions';
    this.requestedCount = meta.requested ?? 0;
    this.batchIndex = meta.batchIndex ?? 0;
    this.totalBatches = meta.totalBatches ?? 0;
    this.supportHint = true;
  }
}

/**
 * Run generation in batches; on parse failure in a batch, retry once then split batch in half.
 * @template T
 * @param {number} total
 * @param {(count: number, ctx: { batchIndex: number, totalBatches: number, priorItems: T[] }) => Promise<T[]>} runBatch
 * @param {{ batchSize?: number }} [opts]
 * @returns {Promise<T[]>}
 */
export async function runQuestionBatches(total, runBatch, opts = {}) {
  const sizes = planQuestionBatches(total, opts.batchSize);
  /** @type {T[]} */
  const all = [];

  for (let i = 0; i < sizes.length; i += 1) {
    const count = sizes[i];
    const ctx = { batchIndex: i + 1, totalBatches: sizes.length, priorItems: all };
    let chunk;
    try {
      chunk = await runBatch(count, ctx);
    } catch (firstErr) {
      try {
        chunk = await runBatch(count, ctx);
      } catch {
        if (count <= 2) throw firstErr;
        const half = Math.ceil(count / 2);
        const a = await runBatch(half, ctx);
        const b = await runBatch(count - half, { ...ctx, priorItems: [...all, ...a] });
        chunk = [...a, ...b];
      }
    }
    if (!Array.isArray(chunk) || chunk.length === 0) {
      throw new AiGenerationError('Empty batch from AI', {
        code: 'AI_GENERATION_EMPTY',
        kind: 'questions',
        requested: total,
        batchIndex: i + 1,
        totalBatches: sizes.length,
      });
    }
    all.push(...chunk);
  }

  return all.slice(0, total);
}
