/**
 * Topic coverage, deduplication, and prompt quality rules for exam question generation.
 */

const DUPLICATE_SIMILARITY_THRESHOLD = Number(process.env.QUESTION_DEDUP_THRESHOLD) || 0.72;
const MAX_REGEN_ATTEMPTS = 4;

/** @param {string[]|string|undefined|null} topics */
export function parseTopicList(topics) {
  if (!topics) return [];
  if (Array.isArray(topics)) {
    return [...new Set(topics.map((t) => String(t).trim()).filter(Boolean))].slice(0, 24);
  }
  return [...new Set(String(topics).split(/[,;|\n]+/).map((t) => t.trim()).filter(Boolean))].slice(0, 24);
}

/**
 * Guarantee ≥1 question per topic when numQuestions ≥ topic count; distribute remainder evenly.
 * @param {number} numQuestions
 * @param {string[]} topicList
 * @returns {{ topic: string, count: number }[]}
 */
export function buildTopicAllocation(numQuestions, topicList) {
  const n = Math.max(1, Math.floor(Number(numQuestions) || 1));
  const topics = topicList.length ? topicList : [];
  if (!topics.length) return [{ topic: '', count: n }];

  const k = topics.length;
  if (n < k) {
    return topics.slice(0, n).map((topic) => ({ topic, count: 1 }));
  }

  const counts = topics.map(() => 1);
  let remaining = n - k;
  let idx = 0;
  while (remaining > 0) {
    counts[idx % k] += 1;
    remaining -= 1;
    idx += 1;
  }
  return topics.map((topic, i) => ({ topic, count: counts[i] }));
}

export function normalizeForComparison(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(text) {
  const norm = normalizeForComparison(text);
  return new Set(norm.split(' ').filter((w) => w.length > 2));
}

/** Token overlap ratio (0–1) for near-duplicate detection. */
export function questionSimilarity(textA, textB) {
  const a = tokenSet(textA);
  const b = tokenSet(textB);
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) {
    if (b.has(t)) inter += 1;
  }
  return inter / Math.min(a.size, b.size);
}

export function isNearDuplicateQuestion(qA, qB, threshold = DUPLICATE_SIMILARITY_THRESHOLD) {
  const tA = typeof qA === 'string' ? qA : qA?.question;
  const tB = typeof qB === 'string' ? qB : qB?.question;
  if (!tA || !tB) return false;
  const nA = normalizeForComparison(tA);
  const nB = normalizeForComparison(tB);
  if (!nA || !nB) return false;
  if (nA === nB) return true;
  if (nA.length > 24 && nB.length > 24 && (nA.includes(nB) || nB.includes(nA))) return true;
  return questionSimilarity(tA, tB) >= threshold;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Remove unnecessary subject/course name prefixes from question stems. */
export function stripSubjectFromQuestion(text, subject) {
  if (!text) return text;
  const subj = String(subject || '').trim();
  if (!subj || subj.length < 2) return text.trim();

  let out = text.trim();
  const patterns = [
    new RegExp(`^\\s*in\\s+${escapeRegex(subj)}\\s*[,:\\-–—]?\\s*`, 'i'),
    new RegExp(`^\\s*in\\s+the\\s+subject\\s+of\\s+${escapeRegex(subj)}\\s*[,:\\-–—]?\\s*`, 'i'),
    new RegExp(`^\\s*for\\s+${escapeRegex(subj)}\\s*[,:\\-–—]?\\s*`, 'i'),
    new RegExp(`^\\s*within\\s+${escapeRegex(subj)}\\s*[,:\\-–—]?\\s*`, 'i'),
    new RegExp(`^\\s*${escapeRegex(subj)}\\s*[:\\-–—]\\s*`, 'i'),
    new RegExp(`^\\s*${escapeRegex(subj)}\\s+subject\\s*[,:\\-–—]?\\s*`, 'i'),
  ];
  for (const re of patterns) {
    out = out.replace(re, '');
  }
  return out.trim() || text.trim();
}

const BANNED_OPTION_PATTERNS = [
  /^all of the above$/i,
  /^none of the above$/i,
  /^both a and b$/i,
  /^all of these$/i,
];

function normalizeMcqOptions(options) {
  if (!Array.isArray(options)) return [];
  return options
    .map((o) => String(o || '').trim())
    .filter(Boolean)
    .slice(0, 6);
}

/** @param {object} q */
export function validateAndNormalizeMcq(q, subject) {
  const question = stripSubjectFromQuestion(q.question || '', subject);
  let options = normalizeMcqOptions(q.options);
  if (options.length < 4) return null;

  options = options.filter((o) => !BANNED_OPTION_PATTERNS.some((re) => re.test(o.replace(/^[A-D]\.\s*/i, ''))));

  const seen = new Set();
  const distinct = [];
  for (const o of options) {
    const key = normalizeForComparison(o.replace(/^[A-D]\.\s*/i, ''));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    distinct.push(o);
  }
  if (distinct.length < 4) return null;

  options = distinct.slice(0, 4);
  let correctAnswer = Number(q.correctAnswer);
  if (!Number.isFinite(correctAnswer) || correctAnswer < 0 || correctAnswer > 3) {
    correctAnswer = 0;
  }

  const assignedTopic = String(q.topic || '').trim();
  return {
    type: 'mcq',
    question,
    options,
    correctAnswer,
    explanation: String(q.explanation || '').trim(),
    topic: assignedTopic || subject || 'General',
  };
}

/** @param {object} q */
export function validateAndNormalizeDescriptive(q, subject) {
  const question = stripSubjectFromQuestion(q.question || '', subject);
  if (!question || question.length < 12) return null;
  if (question.length > 520) return null;

  return {
    type: 'descriptive',
    question,
    modelAnswer: String(q.modelAnswer || '').trim().slice(0, 2500),
    keyPoints: Array.isArray(q.keyPoints) ? q.keyPoints.map(String).filter(Boolean).slice(0, 6) : [],
    explanation: String(q.explanation || '').trim(),
    topic: String(q.topic || '').trim() || subject || 'General',
    options: [],
    correctAnswer: undefined,
  };
}

/**
 * Shared prompt rules for natural, non-repetitive classroom questions.
 * @param {string} subject — course label for metadata only
 * @param {{ focusTopic?: string, topicList?: string[], resourceMode?: boolean }} [opts]
 */
export function buildQualityPromptRules(subject, opts = {}) {
  const { focusTopic, topicList = [], resourceMode = false } = opts;
  const topicBlock = topicList.length
    ? `\nTEACHER TOPICS (must align; set JSON "topic" to the matching label):\n${topicList.map((t) => `- ${t}`).join('\n')}`
    : '';
  const focusBlock = focusTopic
    ? `\nREQUIRED FOCUS for every question in this batch: "${focusTopic}" (use this exact topic label in the "topic" field).`
    : '';
  const resourceBlock = resourceMode
    ? `\nRESOURCE MODE: Use ONLY provided source material. Topics guide what to ask — do not introduce content outside the source that does not match the requested topic.`
    : '';

  return `
CLASSROOM LANGUAGE (mandatory):
- Write direct, natural questions a teacher would use in class.
- Do NOT begin questions with "In ${subject}", "In the subject of ${subject}", "For ${subject}", or similar — unless the subject name is essential to disambiguate.
- The course name "${subject}" is for your context only; do not repeat it in question stems.
- Vary openings: What, Which, Why, How, When, Under what conditions, Compare, Identify, etc.
- Avoid template repetition (not every question starting the same way).
${topicBlock}${focusBlock}${resourceBlock}

MCQ QUALITY (when applicable):
- Four distinct, plausible options — no obvious throwaways.
- Avoid "All of the above", "None of the above", and duplicate options.
- Vary which option is correct (correctAnswer 0–3) across questions.
- Distractors should reflect realistic misconceptions.

DESCRIPTIVE QUALITY (when applicable):
- Test understanding with clear, concise prompts (not vague "Discuss everything").
- Model answers should be focused (3–5 sentences max).
`;
}

export function deduplicateQuestions(questions, threshold = DUPLICATE_SIMILARITY_THRESHOLD) {
  /** @type {typeof questions} */
  const kept = [];
  for (const q of questions) {
    const dup = kept.some((k) => isNearDuplicateQuestion(k, q, threshold));
    if (!dup) kept.push(q);
  }
  return kept;
}

function matchQuestionToTopic(q, topic) {
  const t = normalizeForComparison(topic);
  if (!t) return true;
  const qTopic = normalizeForComparison(q.topic || '');
  const qText = normalizeForComparison(q.question || '');
  if (qTopic && (qTopic === t || qTopic.includes(t) || t.includes(qTopic))) return true;
  const topicTokens = t.split(' ').filter((w) => w.length > 2);
  if (!topicTokens.length) return false;
  const hits = topicTokens.filter((tok) => qText.includes(tok)).length;
  return hits >= Math.min(2, topicTokens.length);
}

export function findUncoveredTopics(questions, topicList) {
  if (!topicList.length) return [];
  return topicList.filter((topic) => !questions.some((q) => matchQuestionToTopic(q, topic)));
}

/** Round-robin interleave for balanced presentation. */
export function interleaveByTopic(questions) {
  if (questions.length <= 1) return questions;
  const buckets = new Map();
  for (const q of questions) {
    const key = (q.topic || 'General').toLowerCase();
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(q);
  }
  const keys = [...buckets.keys()];
  const out = [];
  let added = true;
  while (added) {
    added = false;
    for (const k of keys) {
      const arr = buckets.get(k);
      if (arr?.length) {
        out.push(arr.shift());
        added = true;
      }
    }
  }
  return out;
}

/**
 * Deduplicate, ensure topic coverage, fill to target count via single-question regeneration.
 * @template T
 * @param {T[]} questions
 * @param {{
 *   subject: string,
 *   topicList: string[],
 *   targetCount: number,
 *   type: 'mcq'|'descriptive'|'coding',
 *   normalize: (q: object) => T | null,
 *   regenerateOne: (ctx: { focusTopic?: string, priorItems: T[] }) => Promise<T | null>,
 * }} opts
 */
export async function finalizeQuestionSet(questions, opts) {
  const { subject, topicList, targetCount, normalize, regenerateOne } = opts;
  let pool = questions.map((q) => normalize(q)).filter(Boolean);

  pool = deduplicateQuestions(pool);

  const tryRegen = async (focusTopic, priorItems) => {
    for (let attempt = 0; attempt < MAX_REGEN_ATTEMPTS; attempt += 1) {
      const candidate = await regenerateOne({ focusTopic, priorItems });
      if (!candidate) continue;
      const norm = normalize(candidate);
      if (!norm) continue;
      if (priorItems.some((p) => isNearDuplicateQuestion(p, norm))) continue;
      return norm;
    }
    return null;
  };

  for (const missingTopic of findUncoveredTopics(pool, topicList)) {
    const added = await tryRegen(missingTopic, pool);
    if (added) {
      added.topic = missingTopic;
      pool.push(added);
    }
  }

  pool = deduplicateQuestions(pool);

  let fillIdx = 0;
  const fillPlan = buildTopicAllocation(targetCount, topicList);
  while (pool.length < targetCount && fillIdx < targetCount * MAX_REGEN_ATTEMPTS) {
    const slot = fillPlan[fillIdx % fillPlan.length];
    const added = await tryRegen(slot.topic || undefined, pool);
    if (added) {
      if (slot.topic) added.topic = slot.topic;
      pool.push(added);
      pool = deduplicateQuestions(pool);
    }
    fillIdx += 1;
  }

  pool = deduplicateQuestions(pool).slice(0, targetCount);
  return interleaveByTopic(pool);
}

/**
 * Topic-planned batch generation orchestrator.
 * @template T
 */
export async function orchestrateTopicBasedGeneration({
  numQuestions,
  topics,
  generateBatch,
  finalizeOpts,
}) {
  const topicList = parseTopicList(topics);
  const plan = buildTopicAllocation(numQuestions, topicList);
  /** @type {T[]} */
  let all = [];

  for (const slot of plan) {
    if (slot.count < 1) continue;
    const batch = await generateBatch({
      count: slot.count,
      focusTopic: slot.topic || undefined,
      priorItems: all,
    });
    all.push(...batch);
  }

  return finalizeQuestionSet(all, {
    ...finalizeOpts,
    topicList,
    targetCount: numQuestions,
  });
}
