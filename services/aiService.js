import { parseAiJsonArray, parseAiJsonObject } from '../utils/aiJsonParse.js';
import { aiChatCompletion, getConfiguredChatModel, getConfiguredVisionModel } from './ai/aiRequestClient.js';
import {
  AiGenerationError,
  maxTokensForCodingBatch,
  maxTokensForDescriptiveBatch,
  maxTokensForMcqBatch,
  runQuestionBatches,
} from './aiQuestionGenUtils.js';
import {
  buildQualityPromptRules,
  isNearDuplicateQuestion,
  orchestrateTopicBasedGeneration,
  parseTopicList,
  stripSubjectFromQuestion,
  validateAndNormalizeDescriptive,
  validateAndNormalizeMcq,
  looksLikeSyllabusMetaQuestion,
} from './questionQualityService.js';

const MAX_SINGLE_REGEN = 4;

const mapMcqRow = (q, subject) => ({
  type: 'mcq',
  question: q.question,
  options: Array.isArray(q.options) ? q.options : [],
  correctAnswer: Number(q.correctAnswer),
  explanation: q.explanation || '',
  topic: q.topic || subject,
});

const mapDescriptiveRow = (q, subject) => ({
  type: 'descriptive',
  question: q.question,
  modelAnswer: q.modelAnswer || '',
  keyPoints: Array.isArray(q.keyPoints) ? q.keyPoints : [],
  explanation: q.explanation || '',
  topic: q.topic || subject,
  options: [],
  correctAnswer: undefined,
});

const mapCodingRow = (q, subject) => ({
  type: 'coding',
  question: q.question || '',
  language: q.language || 'javascript',
  starterCode: q.starterCode || '',
  sampleSolution: q.sampleSolution || '',
  explanation: q.explanation || '',
  topic: q.topic || subject,
  options: [],
  correctAnswer: undefined,
});

async function requestJsonArray(prompt, maxTokens, kind, requested) {
  const completion = await aiChatCompletion({
    model: getConfiguredChatModel(),
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.85,
    max_tokens: maxTokens,
  }, { operation: `generate_${kind}` });
  const text = completion.choices[0]?.message?.content?.trim();
  try {
    return parseAiJsonArray(text);
  } catch {
    throw new AiGenerationError(`AI failed to return valid JSON for ${kind} questions`, {
      code: 'AI_GENERATION_JSON_FAILED',
      kind,
      requested,
    });
  }
}

function batchAvoidBlock(priorItems, field = 'question') {
  if (!priorItems?.length) return '';
  return `\nDo NOT repeat or closely paraphrase these existing questions (different concept, scenario, and wording):\n${
    priorItems.slice(-16).map((q) => `- ${String(q[field] || '').slice(0, 140)}`).join('\n')
  }`;
}

function batchNoteLine(count, batchIndex, totalBatches) {
  if (totalBatches <= 1) return '';
  return `\nThis is batch ${batchIndex} of ${totalBatches}. Generate exactly ${count} NEW questions for this batch only.`;
}

async function generateMcqBatchRaw({
  subject, difficulty, topicList, count, focusTopic, priorItems, contextText, resourceMode,
  additionalInstructions, curriculum, curriculumWebMode, curriculumTopicGuidance,
}) {
  return runQuestionBatches(count, async (batchCount, { batchIndex, totalBatches, priorItems: batchPrior }) => {
    const combinedPrior = [...priorItems, ...batchPrior];
    const seed = Math.floor(Math.random() * 10000) + batchIndex * 997;
    const useResourceContext = Boolean(contextText) && !curriculumWebMode;
    const contextSection = useResourceContext
      ? `\n\nBASE QUESTIONS STRICTLY ON THIS CONTENT:\n"""\n${contextText.slice(0, 6000)}\n"""`
      : '';
    const topicLabel = focusTopic || (topicList[0] || 'General');
    const topicFieldRule = curriculumWebMode
      ? `Each question's "topic" field must name the CONCEPT assessed (e.g. "${topicLabel}"), not a chapter or unit title.`
      : `Each question's "topic" field must be: "${topicLabel}" (or the closest teacher topic label from the list).`;
    const prompt = `You are an expert exam question creator. Generate exactly ${batchCount} UNIQUE multiple choice questions at ${difficulty} difficulty.
Course context (do NOT repeat this name in question stems): "${subject}"
${buildQualityPromptRules(subject, {
  focusTopic, topicList, resourceMode, additionalInstructions, curriculum,
  curriculumWebMode, curriculumTopicGuidance,
})}${contextSection}${batchNoteLine(batchCount, batchIndex, totalBatches)}${batchAvoidBlock(combinedPrior)}
${topicFieldRule}
Batch ID: ${seed}

Return ONLY a valid JSON array, no markdown:
[
  {
    "question": "...",
    "options": ["A. ...", "B. ...", "C. ...", "D. ..."],
    "correctAnswer": 0,
    "explanation": "...",
    "topic": "${topicLabel}"
  }
]

Rules:
- correctAnswer is 0-based (0=A, 1=B, 2=C, 3=D)
- Inside JSON strings use \\n for line breaks — never raw newline or tab characters inside a string value`;

    const questions = await requestJsonArray(prompt, maxTokensForMcqBatch(batchCount), 'mcq', batchCount);
    if (!Array.isArray(questions) || questions.length === 0) {
      throw new AiGenerationError('No questions generated', {
        code: 'AI_GENERATION_EMPTY',
        kind: 'mcq',
        requested: batchCount,
        batchIndex,
        totalBatches,
      });
    }
    return questions
      .map((q) => validateAndNormalizeMcq({ ...q, topic: q.topic || topicLabel }, subject))
      .filter((q) => q && (!curriculumWebMode || !looksLikeSyllabusMetaQuestion(q.question)));
  });
}

export const generateMCQs = async ({
  subject, difficulty, numQuestions, topics, contextText, additionalInstructions, curriculum,
  curriculumWebMode, curriculumTopicGuidance,
}) => {
  const total = Math.max(1, Math.floor(Number(numQuestions) || 1));
  const topicList = parseTopicList(topics);
  const webOpts = { curriculumWebMode, curriculumTopicGuidance };

  const genOpts = {
    singleBatch: true,
    lightFinalize: Boolean(curriculumWebMode) || topicList.length > 6,
  };

  return orchestrateTopicBasedGeneration({
    numQuestions: total,
    topics: topicList,
    ...genOpts,
    generateBatch: ({ count, focusTopic, priorItems }) => generateMcqBatchRaw({
      subject,
      difficulty,
      topicList,
      count,
      focusTopic,
      priorItems,
      contextText,
      resourceMode: Boolean(contextText) && !curriculumWebMode,
      additionalInstructions,
      curriculum,
      ...webOpts,
    }),
    finalizeOpts: {
      subject,
      type: 'mcq',
      normalize: (q) => validateAndNormalizeMcq(q, subject),
      regenerateOne: genOpts.lightFinalize ? undefined : async ({ focusTopic, priorItems }) => {
        const batch = await generateMcqBatchRaw({
          subject, difficulty, topicList, count: 1, focusTopic, priorItems, contextText,
          resourceMode: Boolean(contextText) && !curriculumWebMode,
          additionalInstructions, curriculum, ...webOpts,
        });
        return batch[0] || null;
      },
    },
  });
};

function normalizeCodingQuestion(q, subject, focusTopic) {
  const question = stripSubjectFromQuestion(q.question || '', subject);
  if (!question || question.length < 20) return null;
  return {
    ...mapCodingRow({ ...q, question }, subject),
    topic: focusTopic || q.topic || subject,
  };
}

async function generateCodingBatchRaw({
  subject, difficulty, topicList, count, focusTopic, priorItems, additionalInstructions,
}) {
  return runQuestionBatches(count, async (batchCount, { batchIndex, totalBatches, priorItems: batchPrior }) => {
    const combinedPrior = [...priorItems, ...batchPrior];
    const seed = Math.floor(Math.random() * 10000) + batchIndex * 991;
    const topicLabel = focusTopic || (topicList[0] || 'General');
    const prompt = `You are an expert coding interview question creator. Generate exactly ${batchCount} UNIQUE coding challenge(s) at ${difficulty} difficulty.
Course context (do NOT repeat in problem stems): "${subject}"
${buildQualityPromptRules(subject, { focusTopic, topicList, additionalInstructions })}${batchNoteLine(batchCount, batchIndex, totalBatches)}${batchAvoidBlock(combinedPrior)}
Each problem's "topic" field must be: "${topicLabel}".
Batch ID: ${seed}

Return ONLY a valid JSON array, no markdown:
[
  {
    "question": "Clear problem statement with input/output requirements and example",
    "language": "javascript",
    "starterCode": "function solution(input) {\\n  // write your code here\\n}",
    "sampleSolution": "function solution(input) { /* working implementation */ }",
    "explanation": "Brief explanation of the approach",
    "topic": "${topicLabel}"
  }
]

Rules:
- Vary problem types (algorithms, data structures, strings, etc.)
- starterCode must be a valid function skeleton
- question must include at least one example (input → output)
- Inside JSON strings use \\n for line breaks — never raw newline or tab characters inside a string value`;

    const completion = await aiChatCompletion({
      model: getConfiguredChatModel(),
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.8,
      max_tokens: maxTokensForCodingBatch(batchCount),
    }, { operation: 'coding_batch' });
    const text = completion.choices[0]?.message?.content?.trim();
    let questions;
    try {
      questions = parseAiJsonArray(text);
    } catch {
      throw new AiGenerationError('AI failed to return valid JSON for coding questions', {
        code: 'AI_GENERATION_JSON_FAILED',
        kind: 'coding',
        requested: batchCount,
        batchIndex,
        totalBatches,
      });
    }
    if (!Array.isArray(questions) || questions.length === 0) {
      throw new AiGenerationError('No coding questions generated', {
        code: 'AI_GENERATION_EMPTY',
        kind: 'coding',
        requested: batchCount,
        batchIndex,
        totalBatches,
      });
    }
    return questions
      .map((q) => normalizeCodingQuestion({ ...q, topic: q.topic || topicLabel }, subject, topicLabel))
      .filter(Boolean);
  });
}

/** Generate N coding questions in batched LLM calls for large exams */
export const generateCodingQuestions = async ({ subject, difficulty, numQuestions, topics, additionalInstructions }) => {
  const total = Math.max(1, Math.floor(Number(numQuestions) || 1));
  const topicList = parseTopicList(topics);

  return orchestrateTopicBasedGeneration({
    numQuestions: total,
    topics: topicList,
    singleBatch: true,
    lightFinalize: topicList.length > 6,
    generateBatch: ({ count, focusTopic, priorItems }) => generateCodingBatchRaw({
      subject, difficulty, topicList, count, focusTopic, priorItems, additionalInstructions,
    }),
    finalizeOpts: {
      subject,
      type: 'coding',
      normalize: (q) => normalizeCodingQuestion(q, subject, q.topic),
      regenerateOne: topicList.length > 6 ? undefined : async ({ focusTopic, priorItems }) => {
        const batch = await generateCodingBatchRaw({
          subject, difficulty, topicList, count: 1, focusTopic, priorItems, additionalInstructions,
        });
        return batch[0] || null;
      },
    },
  });
};

/** @deprecated use generateCodingQuestions instead */
export const generateCodingQuestion = async ({ subject, difficulty, topic }) => {
  const result = await generateCodingQuestions({ subject, difficulty, numQuestions: 1, topics: topic ? [topic] : [] });
  return result[0];
};

export const evaluateCodingAnswer = async ({ question, code, language, sampleSolution, difficulty }) => {
  if (!code || code.trim().length < 5) {
    return { isCorrect: false, score: 0, feedback: 'No code submitted.' };
  }

  const prompt = `You are a senior software engineer doing a fair and thorough code review for an exam submission.

PROBLEM:
${question}

LANGUAGE: ${language}
DIFFICULTY: ${difficulty}
${sampleSolution ? `\nREFERENCE APPROACH (one possible solution — do NOT require this exact approach):\n${sampleSolution}\n` : ''}
SUBMITTED CODE:
\`\`\`${language}
${code}
\`\`\`

EVALUATION GUIDELINES:
- Award full marks (90-100) for any logically correct solution, even if different from the reference
- Award 70-89 for correct solutions with minor inefficiencies or style issues
- Award 50-69 for partially correct solutions that handle most cases
- Award 20-49 for code that shows understanding but has logical errors
- Award 0-19 for completely incorrect or empty submissions
- Be LENIENT: different valid algorithms (e.g., recursive vs iterative) are equally valid
- Do NOT penalize for language style differences or minor variable naming

Respond ONLY with valid JSON (no other text):
{
  "score": <integer 0-100>,
  "isCorrect": <true if score >= 60>,
  "feedback": "<1-2 encouraging sentences noting what is right and what could improve>"
}`;

  try {
    const completion = await aiChatCompletion({
      model: getConfiguredChatModel(),
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 300,
    }, { operation: 'evaluate_coding' });
    const text = completion.choices[0]?.message?.content?.trim();
    let result;
    try {
      result = parseAiJsonObject(text);
    } catch {
      return { isCorrect: false, score: 0, feedback: 'Evaluation could not be completed.' };
    }
    const score = Math.max(0, Math.min(100, Number(result.score) || 0));
    return { score, isCorrect: score >= 60, feedback: result.feedback || '' };
  } catch {
    return { isCorrect: false, score: 0, feedback: 'Evaluation service unavailable.' };
  }
};

async function generateDescriptiveBatchRaw({
  subject, difficulty, topicList, count, focusTopic, priorItems, contextText, resourceMode,
  additionalInstructions, curriculum, curriculumWebMode, curriculumTopicGuidance,
}) {
  return runQuestionBatches(count, async (batchCount, { batchIndex, totalBatches, priorItems: batchPrior }) => {
    const combinedPrior = [...priorItems, ...batchPrior];
    const seed = Math.floor(Math.random() * 10000) + batchIndex * 983;
    const useResourceContext = Boolean(contextText) && !curriculumWebMode;
    const contextSection = useResourceContext
      ? `\n\nBASE YOUR QUESTIONS STRICTLY ON THIS CONTENT:\n"""\n${contextText.slice(0, 6000)}\n"""`
      : '';
    const topicLabel = focusTopic || (topicList[0] || 'General');
    const topicFieldRule = curriculumWebMode
      ? `Each question's "topic" field must name the CONCEPT assessed (e.g. "${topicLabel}"), not a chapter or unit title.`
      : `Each question's "topic" field must be: "${topicLabel}".`;
    const prompt = `You are an expert exam question creator. Generate exactly ${batchCount} UNIQUE descriptive/open-ended questions at ${difficulty} difficulty.
Course context (do NOT repeat in question stems): "${subject}"
${buildQualityPromptRules(subject, {
  focusTopic, topicList, resourceMode, additionalInstructions, curriculum,
  curriculumWebMode, curriculumTopicGuidance,
})}${contextSection}${batchNoteLine(batchCount, batchIndex, totalBatches)}${batchAvoidBlock(combinedPrior)}
${topicFieldRule}
Batch ID: ${seed}

Return ONLY a valid JSON array, no markdown:
[
  {
    "question": "...",
    "modelAnswer": "...",
    "keyPoints": ["...", "..."],
    "explanation": "...",
    "topic": "${topicLabel}"
  }
]

Inside JSON strings use \\n for line breaks — never raw newline or tab characters inside a string value`;

    const questions = await requestJsonArray(
      prompt,
      maxTokensForDescriptiveBatch(batchCount),
      'descriptive',
      batchCount,
    );
    if (!Array.isArray(questions) || questions.length === 0) {
      throw new AiGenerationError('No questions generated', {
        code: 'AI_GENERATION_EMPTY',
        kind: 'descriptive',
        requested: batchCount,
        batchIndex,
        totalBatches,
      });
    }
    return questions
      .map((q) => validateAndNormalizeDescriptive({ ...q, topic: q.topic || topicLabel }, subject))
      .filter((q) => q && (!curriculumWebMode || !looksLikeSyllabusMetaQuestion(q.question)));
  });
}

/** Generate N descriptive (open-ended) questions */
export const generateDescriptiveQuestions = async ({
  subject, difficulty, numQuestions, topics, contextText, additionalInstructions, curriculum,
  curriculumWebMode, curriculumTopicGuidance,
}) => {
  const total = Math.max(1, Math.floor(Number(numQuestions) || 1));
  const topicList = parseTopicList(topics);
  const webOpts = { curriculumWebMode, curriculumTopicGuidance };

  const lightFinalize = Boolean(curriculumWebMode) || topicList.length > 6;

  return orchestrateTopicBasedGeneration({
    numQuestions: total,
    topics: topicList,
    singleBatch: true,
    lightFinalize,
    generateBatch: ({ count, focusTopic, priorItems }) => generateDescriptiveBatchRaw({
      subject,
      difficulty,
      topicList,
      count,
      focusTopic,
      priorItems,
      contextText,
      resourceMode: Boolean(contextText) && !curriculumWebMode,
      additionalInstructions,
      curriculum,
      ...webOpts,
    }),
    finalizeOpts: {
      subject,
      type: 'descriptive',
      normalize: (q) => validateAndNormalizeDescriptive(q, subject),
      regenerateOne: lightFinalize ? undefined : async ({ focusTopic, priorItems }) => {
        const batch = await generateDescriptiveBatchRaw({
          subject, difficulty, topicList, count: 1, focusTopic, priorItems, contextText,
          resourceMode: Boolean(contextText) && !curriculumWebMode,
          additionalInstructions, curriculum, ...webOpts,
        });
        return batch[0] || null;
      },
    },
  });
};

/** Generate questions from uploaded content text (PDF/doc) — legacy full-document path */
export const generateQuestionsFromText = async ({
  text, numQuestions, examType = 'mcq', difficulty = 'medium', mixedMcqPercent = 50, topics = [], additionalInstructions, curriculum,
}) => {
  const truncated = text.slice(0, 8000);
  const topicList = parseTopicList(topics);

  if (examType === 'descriptive' || examType === 'mixed') {
    let pct = Number(mixedMcqPercent);
    if (!Number.isFinite(pct)) pct = 50;
    pct = Math.max(10, Math.min(90, Math.round(pct)));
    let mcqCount = examType === 'mixed'
      ? (numQuestions <= 1 ? (pct >= 50 ? 1 : 0) : Math.max(1, Math.min(numQuestions - 1, Math.round((numQuestions * pct) / 100))))
      : 0;
    let descCount = examType === 'mixed' ? numQuestions - mcqCount : numQuestions;
    if (examType === 'mixed' && numQuestions <= 1) descCount = numQuestions - mcqCount;
    const [desc, mcqs] = await Promise.all([
      descCount > 0
        ? generateDescriptiveQuestions({
          subject: 'uploaded content', difficulty, numQuestions: descCount, topics: topicList, contextText: truncated, additionalInstructions, curriculum,
        })
        : Promise.resolve([]),
      mcqCount > 0
        ? generateMCQsFromText({ text: truncated, numQuestions: mcqCount, difficulty, topics: topicList, additionalInstructions, curriculum })
        : Promise.resolve([]),
    ]);
    return [...mcqs, ...desc];
  }
  return generateMCQsFromText({ text: truncated, numQuestions, difficulty, topics: topicList, additionalInstructions, curriculum });
};

const GROUNDED_RULES = `MANDATORY CONSTRAINTS:
- Use ONLY facts, definitions, examples, and terminology that appear in SOURCE SNIPPETS below.
- Do NOT use outside knowledge, the open web, or information not explicitly supported by the snippets.
- Do NOT hallucinate names, numbers, dates, formulas, or claims.
- Every correct answer and every distractor must be consistent with the snippets (distractors may be subtle misunderstandings of the same material).
- If the snippets do not support enough distinct, high-quality questions, return FEWER than requested — never invent filler questions.
- Align difficulty with how deeply the snippets support reasoning vs recall.`;

async function generateGroundedMcqBatchRaw({
  context, subject, difficulty, topicList, count, focusTopic, priorItems, seedBase, additionalInstructions, curriculum,
}) {
  return runQuestionBatches(count, async (batchCount, { batchIndex, totalBatches, priorItems: batchPrior }) => {
    const combinedPrior = [...priorItems, ...batchPrior];
    const batchSeed = (seedBase || 0) + batchIndex * 131;
    const topicLabel = focusTopic || (topicList[0] || 'Material');
    const focusBlock = focusTopic
      ? `\nREQUIRED FOCUS: "${focusTopic}" — only ask about this concept using snippet facts. Set "topic" to "${focusTopic}".`
      : '';
    const prompt = `You are an expert exam author.

${GROUNDED_RULES}
${focusBlock}
${buildQualityPromptRules(subject, { focusTopic, topicList, resourceMode: true, additionalInstructions, curriculum })}

Difficulty: ${difficulty}
Course label (context only, not in stems): "${subject}"

SOURCE SNIPPETS:
"""
${context}
"""

Batch ID: ${batchSeed}${batchNoteLine(batchCount, batchIndex, totalBatches)}${batchAvoidBlock(combinedPrior)}

Return ONLY a valid JSON array with exactly ${batchCount} objects:
[
  {
    "question": "...",
    "options": ["A. ...", "B. ...", "C. ...", "D. ..."],
    "correctAnswer": 0,
    "explanation": "...",
    "topic": "${topicLabel}"
  }
]

Inside JSON strings use \\n for line breaks — never raw newline or tab characters inside a string value`;

    const completion = await aiChatCompletion({
      model: getConfiguredChatModel(),
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.55,
      max_tokens: maxTokensForMcqBatch(batchCount),
    }, { operation: 'grounded_mcq' });
    const t = completion.choices[0]?.message?.content?.trim();
    let qs;
    try {
      qs = parseAiJsonArray(t);
    } catch {
      throw new AiGenerationError('AI failed to generate grounded MCQ JSON', {
        code: 'AI_GENERATION_JSON_FAILED',
        kind: 'mcq',
        requested: batchCount,
        batchIndex,
        totalBatches,
      });
    }
    if (!Array.isArray(qs) || qs.length === 0) {
      throw new AiGenerationError('No grounded questions generated', {
        code: 'AI_GENERATION_EMPTY',
        kind: 'mcq',
        requested: batchCount,
        batchIndex,
        totalBatches,
      });
    }
    return qs
      .map((q) => validateAndNormalizeMcq({ ...q, topic: q.topic || topicLabel }, subject))
      .filter(Boolean);
  });
}

const generateMCQsFromGroundedSnippets = async ({
  context, subject, numQuestions, difficulty, seed, topics, additionalInstructions, curriculum,
}) => {
  const total = Math.max(1, Math.floor(Number(numQuestions) || 1));
  const topicList = parseTopicList(topics);
  const seedBase = seed ?? Math.floor(Math.random() * 10000);

  const lightFinalize = topicList.length > 6;

  return orchestrateTopicBasedGeneration({
    numQuestions: total,
    topics: topicList,
    singleBatch: true,
    lightFinalize,
    generateBatch: ({ count, focusTopic, priorItems }) => generateGroundedMcqBatchRaw({
      context, subject, difficulty, topicList, count, focusTopic, priorItems, seedBase, additionalInstructions, curriculum,
    }),
    finalizeOpts: {
      subject,
      type: 'mcq',
      normalize: (q) => validateAndNormalizeMcq(q, subject),
      regenerateOne: lightFinalize ? undefined : async ({ focusTopic, priorItems }) => {
        const batch = await generateGroundedMcqBatchRaw({
          context, subject, difficulty, topicList, count: 1, focusTopic, priorItems, seedBase, additionalInstructions, curriculum,
        });
        return batch[0] || null;
      },
    },
  });
};

async function generateGroundedDescriptiveBatchRaw({
  context, subject, difficulty, topicList, count, focusTopic, priorItems, seedBase, additionalInstructions, curriculum,
}) {
  return runQuestionBatches(count, async (batchCount, { batchIndex, totalBatches, priorItems: batchPrior }) => {
    const combinedPrior = [...priorItems, ...batchPrior];
    const batchSeed = (seedBase || 0) + batchIndex * 127;
    const topicLabel = focusTopic || (topicList[0] || 'Material');
    const focusBlock = focusTopic
      ? `\nREQUIRED FOCUS: "${focusTopic}" — only ask about this concept using snippet facts. Set "topic" to "${focusTopic}".`
      : '';
    const prompt = `You are an expert exam author.

${GROUNDED_RULES}
${focusBlock}
${buildQualityPromptRules(subject, { focusTopic, topicList, resourceMode: true, additionalInstructions, curriculum })}

Difficulty: ${difficulty}
Course label (context only, not in stems): "${subject}"

SOURCE SNIPPETS:
"""
${context}
"""

Batch ID: ${batchSeed}${batchNoteLine(batchCount, batchIndex, totalBatches)}${batchAvoidBlock(combinedPrior)}

Return ONLY a valid JSON array with exactly ${batchCount} objects:
[
  {
    "question": "...",
    "modelAnswer": "Derived strictly from the snippets",
    "keyPoints": ["...", "..."],
    "explanation": "What this question checks in the material",
    "topic": "${topicLabel}"
  }
]

Inside JSON strings use \\n for line breaks — never raw newline or tab characters inside a string value`;

    const completion = await aiChatCompletion({
      model: getConfiguredChatModel(),
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.55,
      max_tokens: maxTokensForDescriptiveBatch(batchCount),
    }, { operation: 'grounded_descriptive' });

    const text = completion.choices[0]?.message?.content?.trim();
    let questions;
    try {
      questions = parseAiJsonArray(text);
    } catch {
      throw new AiGenerationError('AI failed to generate grounded descriptive JSON', {
        code: 'AI_GENERATION_JSON_FAILED',
        kind: 'descriptive',
        requested: batchCount,
        batchIndex,
        totalBatches,
      });
    }
    if (!Array.isArray(questions) || questions.length === 0) {
      throw new AiGenerationError('No grounded descriptive questions generated', {
        code: 'AI_GENERATION_EMPTY',
        kind: 'descriptive',
        requested: batchCount,
        batchIndex,
        totalBatches,
      });
    }
    return questions
      .map((q) => validateAndNormalizeDescriptive({ ...q, topic: q.topic || topicLabel }, subject))
      .filter(Boolean);
  });
}

const generateDescriptiveFromGroundedSnippets = async ({
  context, subject, numQuestions, difficulty, topics, seed, additionalInstructions, curriculum,
}) => {
  const total = Math.max(1, Math.floor(Number(numQuestions) || 1));
  const topicList = parseTopicList(topics);
  const seedBase = seed ?? Math.floor(Math.random() * 10000);

  const lightFinalize = topicList.length > 6;

  return orchestrateTopicBasedGeneration({
    numQuestions: total,
    topics: topicList,
    singleBatch: true,
    lightFinalize,
    generateBatch: ({ count, focusTopic, priorItems }) => generateGroundedDescriptiveBatchRaw({
      context, subject, difficulty, topicList, count, focusTopic, priorItems, seedBase, additionalInstructions, curriculum,
    }),
    finalizeOpts: {
      subject,
      type: 'descriptive',
      normalize: (q) => validateAndNormalizeDescriptive(q, subject),
      regenerateOne: lightFinalize ? undefined : async ({ focusTopic, priorItems }) => {
        const batch = await generateGroundedDescriptiveBatchRaw({
          context, subject, difficulty, topicList, count: 1, focusTopic, priorItems, seedBase, additionalInstructions, curriculum,
        });
        return batch[0] || null;
      },
    },
  });
};

/**
 * RAG-backed generation: `context` must be retrieval-composed snippets only.
 */
export const generateGroundedExamQuestions = async ({
  context, subject, numQuestions, examType = 'mcq', difficulty = 'medium', mixedMcqPercent = 50, topics = [], additionalInstructions, curriculum,
}) => {
  const ctx = (context || '').trim();
  if (ctx.length < 40) throw new Error('Insufficient retrieved material for grounded generation.');

  const subj = (subject || '').trim() || 'Uploaded study material';
  const seed = Math.floor(Math.random() * 10000);

  if (examType === 'descriptive') {
    return generateDescriptiveFromGroundedSnippets({
      context: ctx, subject: subj, numQuestions, difficulty, topics, seed, additionalInstructions, curriculum,
    });
  }

  if (examType === 'mixed') {
    let pct = Number(mixedMcqPercent);
    if (!Number.isFinite(pct)) pct = 50;
    pct = Math.max(10, Math.min(90, Math.round(pct)));
    let mcqCount = numQuestions <= 1
      ? (pct >= 50 ? 1 : 0)
      : Math.max(1, Math.min(numQuestions - 1, Math.round((numQuestions * pct) / 100)));
    let descCount = numQuestions - mcqCount;
    if (numQuestions <= 1) descCount = numQuestions - mcqCount;
    const topicList = parseTopicList(topics);
    const [mcqs, desc] = await Promise.all([
      mcqCount > 0 ? generateMCQsFromGroundedSnippets({
        context: ctx, subject: subj, numQuestions: mcqCount, difficulty, seed: seed + 1, topics: topicList, additionalInstructions, curriculum,
      }) : Promise.resolve([]),
      descCount > 0 ? generateDescriptiveFromGroundedSnippets({
        context: ctx, subject: subj, numQuestions: descCount, difficulty, topics: topicList, seed: seed + 2, additionalInstructions, curriculum,
      }) : Promise.resolve([]),
    ]);
    return [...mcqs, ...desc];
  }

  return generateMCQsFromGroundedSnippets({
    context: ctx, subject: subj, numQuestions, difficulty, seed, topics, additionalInstructions, curriculum,
  });
};

const generateMCQsFromText = async ({ text, numQuestions, difficulty, topics, additionalInstructions, curriculum }) => {
  const total = Math.max(1, Math.floor(Number(numQuestions) || 1));
  const topicList = parseTopicList(topics);
  const subject = 'uploaded content';

  const lightFinalize = topicList.length > 6;

  return orchestrateTopicBasedGeneration({
    numQuestions: total,
    topics: topicList,
    singleBatch: true,
    lightFinalize,
    generateBatch: ({ count, focusTopic, priorItems }) => generateMcqBatchRaw({
      subject,
      difficulty,
      topicList,
      count,
      focusTopic,
      priorItems,
      contextText: text,
      resourceMode: true,
      additionalInstructions,
      curriculum,
    }),
    finalizeOpts: {
      subject,
      type: 'mcq',
      normalize: (q) => validateAndNormalizeMcq(q, subject),
      regenerateOne: lightFinalize ? undefined : async ({ focusTopic, priorItems }) => {
        const batch = await generateMcqBatchRaw({
          subject, difficulty, topicList, count: 1, focusTopic, priorItems, contextText: text, resourceMode: true, additionalInstructions, curriculum,
        });
        return batch[0] || null;
      },
    },
  });
};

function pickUniqueQuestion(candidate, priorItems) {
  if (!candidate) return null;
  if (priorItems.some((p) => isNearDuplicateQuestion(p, candidate))) return null;
  return candidate;
}

/** Regenerate a single question (replace one in the array) */
export const generateSingleQuestion = async ({
  subject,
  difficulty,
  examType = 'mcq',
  existingQuestions = [],
  topic,
  contextText,
  groundedMode = false,
  extraGuidance,
  questionStyle,
  additionalInstructions,
  curriculum,
}) => {
  const priorItems = existingQuestions.filter((q) => q?.question);
  const ctxCap = groundedMode ? 14_000 : 3000;
  const topicForLists = topic ? [String(topic).trim()] : [];
  if (extraGuidance) topicForLists.push(String(extraGuidance).trim().slice(0, 160));
  const topics = topicForLists.filter(Boolean).slice(0, 8);

  const acceptOrRetry = async (factory) => {
    let last = null;
    for (let attempt = 0; attempt < MAX_SINGLE_REGEN; attempt += 1) {
      const batch = await factory();
      const candidate = batch?.[0] || null;
      if (!candidate) continue;
      last = candidate;
      const unique = pickUniqueQuestion(candidate, priorItems);
      if (unique) return unique;
    }
    return last;
  };

  if (examType === 'descriptive') {
    if (groundedMode && contextText?.trim()) {
      return acceptOrRetry(() => generateDescriptiveFromGroundedSnippets({
        context: contextText.slice(0, ctxCap),
        subject,
        numQuestions: 1,
        difficulty,
        topics,
        seed: Math.floor(Math.random() * 10000),
        additionalInstructions,
      }));
    }
    return acceptOrRetry(() => generateDescriptiveQuestions({
      subject,
      difficulty,
      numQuestions: 1,
      topics,
      contextText,
      additionalInstructions,
    }));
  }

  if (examType === 'coding') {
    return acceptOrRetry(() => generateCodingQuestions({
      subject, difficulty, numQuestions: 1, topics, additionalInstructions,
    }));
  }

  if (groundedMode && contextText?.trim()) {
    return acceptOrRetry(() => generateMCQsFromGroundedSnippets({
      context: contextText.slice(0, ctxCap),
      subject,
      numQuestions: 1,
      difficulty,
      topics,
      seed: Math.floor(Math.random() * 10000),
      additionalInstructions,
    }));
  }

  if (contextText?.trim()) {
    return acceptOrRetry(() => generateMCQsFromText({
      text: contextText.slice(0, ctxCap),
      numQuestions: 1,
      difficulty,
      topics,
      additionalInstructions,
    }));
  }

  const guideLine = extraGuidance
    ? `\nTeacher notes: ${String(extraGuidance).trim().slice(0, 600)}`
    : '';
  const styleLine = questionStyle === 'concept_check'
    ? '\nStyle: concise concept check (definitions, recognition, short stem).'
    : questionStyle === 'application'
      ? '\nStyle: short scenario or application stem appropriate to the level.'
      : '';
  const focusTopic = topic || undefined;

  for (let attempt = 0; attempt < MAX_SINGLE_REGEN; attempt += 1) {
    const seed = Math.floor(Math.random() * 10000) + attempt * 503;
    const prompt = `Generate exactly 1 unique MCQ at ${difficulty} difficulty.
${buildQualityPromptRules(subject, { focusTopic, topicList: topics, additionalInstructions, curriculum })}
${guideLine}${styleLine}${batchAvoidBlock(priorItems)}
Batch ID: ${seed}

Return ONLY a single JSON object (not an array):
{
  "question": "...",
  "options": ["A. ...", "B. ...", "C. ...", "D. ..."],
  "correctAnswer": 0,
  "explanation": "...",
  "topic": "${focusTopic || subject}"
}

Inside JSON strings use \\n for line breaks — never raw newline or tab characters inside a string value.`;

    const completion = await aiChatCompletion({
      model: getConfiguredChatModel(),
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.9,
      max_tokens: 512,
    }, { operation: 'regenerate_single_mcq' });

    const text = completion.choices[0]?.message?.content?.trim();
    let raw;
    try {
      raw = parseAiJsonObject(text);
    } catch {
      continue;
    }
    const normalized = validateAndNormalizeMcq(
      { ...raw, topic: raw.topic || focusTopic || subject },
      subject,
    );
    const unique = pickUniqueQuestion(normalized, priorItems);
    if (unique) return unique;
  }

  throw new AiGenerationError('AI failed to generate a unique replacement question', {
    code: 'AI_GENERATION_EMPTY',
    kind: 'mcq',
  });
};

/** Evaluate a descriptive answer using AI */
export const evaluateDescriptiveAnswer = async ({ question, answer, modelAnswer, keyPoints, difficulty }) => {
  if (!answer || answer.trim().length < 5) {
    return { isCorrect: false, score: 0, feedback: 'No answer submitted.' };
  }
  const keyPointsText = keyPoints?.length ? `\nKey concepts expected: ${keyPoints.join(', ')}` : '';
  const modelText = modelAnswer ? `\nModel answer reference: ${modelAnswer}` : '';

  const prompt = `You are evaluating a student's descriptive exam answer.

QUESTION: ${question}${modelText}${keyPointsText}
DIFFICULTY: ${difficulty || 'medium'}

STUDENT ANSWER:
"""
${answer.slice(0, 2000)}
"""

Evaluate fairly. Award marks for:
- Correct understanding of core concepts (50%)
- Completeness of answer (30%)
- Clarity and structure (20%)

Be lenient with wording — reward conceptual understanding over exact phrasing.

Respond ONLY with valid JSON:
{"score": <integer 0-100>, "isCorrect": <true if score >= 50>, "feedback": "<1-2 encouraging sentences>"}`;

  try {
    const completion = await aiChatCompletion({
      model: getConfiguredChatModel(),
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 200,
    }, { operation: 'evaluate_descriptive', skipHealthRecording: true });
    const text = completion.choices[0]?.message?.content?.trim();
    let result;
    try {
      result = parseAiJsonObject(text);
    } catch {
      return { isCorrect: false, score: 0, feedback: 'Evaluation unavailable.' };
    }
    const score = Math.max(0, Math.min(100, Number(result.score) || 0));
    return { score, isCorrect: score >= 50, feedback: result.feedback || '' };
  } catch {
    return { isCorrect: false, score: 0, feedback: 'Evaluation service unavailable.' };
  }
};

export const generateRecommendation = async ({ weakTopics, recentScores, subject }) => {
  const prompt = `Based on student performance data:
- Weak topics: ${weakTopics.join(', ') || 'none identified'}
- Recent scores: ${recentScores.join(', ')}%
- Subject: ${subject}

Suggest:
1. The best topic to practice next
2. Recommended difficulty (easy/medium/hard)
3. One short study tip (max 2 sentences)

Return JSON: {"topic": "...", "difficulty": "...", "tip": "..."}`;

  try {
    const completion = await aiChatCompletion({
      model: getConfiguredChatModel(),
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.5,
      max_tokens: 256,
    }, { operation: 'recommendation', skipHealthRecording: true });
    const text = completion.choices[0]?.message?.content?.trim();
    return parseAiJsonObject(text);
  } catch {
    return null;
  }
};

const LISTENING_EXERCISE_TYPES = 'dictation | listening_comprehension | spoken_passage | audio_mcq | fill_blank_from_audio | short_listening_desc';

const NARRATION_STYLE_GUIDANCE = {
  formal: 'NARRATION VOICE: polished, formal academic English—suitable for high-stakes exams.',
  conversational: 'NARRATION VOICE: natural, conversational English while staying clear and classroom-appropriate.',
  academic: 'NARRATION VOICE: standard instructional academic tone—neutral, precise, easy to follow.',
  kids_friendly: 'NARRATION VOICE: warm, encouraging, age-appropriate for younger learners—still professional.',
};

const narrationStyleLine = (styleRaw) => {
  const k = String(styleRaw || 'academic').toLowerCase();
  return NARRATION_STYLE_GUIDANCE[k] || NARRATION_STYLE_GUIDANCE.academic;
};

const normalizeListeningQuestion = (raw, subject, replayLimit) => {
  const type = raw.type === 'descriptive' ? 'descriptive' : 'mcq';
  const listeningExerciseType = String(raw.listeningExerciseType || 'listening_comprehension').slice(0, 64);
  const narrationText = String(raw.narrationText || '').trim();
  const question = String(raw.question || '').trim();
  const audioTranscript = String(raw.audioTranscript || narrationText || '').trim();
  const base = {
    isAudioQuestion: true,
    listeningExerciseType,
    question,
    narrationText,
    audioTranscript,
    explanation: String(raw.explanation || '').trim(),
    topic: String(raw.topic || subject || 'Listening').slice(0, 120),
    replayLimit: typeof replayLimit === 'number' && replayLimit >= 1 ? replayLimit : undefined,
    audioUrl: '',
    audioCloudinaryPublicId: '',
    audioDuration: undefined,
    audioVoice: '',
    audioLanguage: '',
  };
  if (type === 'descriptive') {
    return {
      ...base,
      type: 'descriptive',
      modelAnswer: String(raw.modelAnswer || '').trim(),
      keyPoints: Array.isArray(raw.keyPoints) ? raw.keyPoints.map(String) : [],
      options: [],
      correctAnswer: undefined,
    };
  }
  return {
    ...base,
    type: 'mcq',
    options: Array.isArray(raw.options) ? raw.options.map(String) : [],
    correctAnswer: Number(raw.correctAnswer),
  };
};

const generateListeningFromGroundedSnippets = async ({
  context, subject, numQuestions, difficulty, topics, replayLimit, seed, narrationStyle,
}) => {
  const topicText = topics?.length ? `Topic hints (stay within snippets): ${topics.join(', ')}.` : '';
  const styleLine = narrationStyleLine(narrationStyle);
  const prompt = `You are an expert assessment author for listening and spoken-language exams.

${GROUNDED_RULES}

${styleLine}

Difficulty: ${difficulty}
${topicText}
Course / subject label (tone only): "${subject}"

SOURCE SNIPPETS:
"""
${context}
"""

Batch ID: ${seed}

Create exactly ${numQuestions} DISTINCT listening exercises. Each item must be answerable ONLY from what can reasonably be inferred from the snippets (no outside facts).

Return ONLY a valid JSON array (no markdown):
[
  {
    "listeningExerciseType": "${LISTENING_EXERCISE_TYPES}",
    "type": "mcq or descriptive",
    "question": "What the student reads on screen AFTER listening (do not paste the full narration here; ask about it)",
    "narrationText": "The exact words that will be read aloud as the listening passage (clear, natural, educational; may include short sentences suitable for dictation when type is dictation)",
    "audioTranscript": "Same as narrationText OR a concise transcript line for accessibility",
    "explanation": "One educational sentence",
    "topic": "short label from snippet vocabulary",
    "options": ["A. ...","B. ...","C. ...","D. ..."],
    "correctAnswer": 0,
    "modelAnswer": "for descriptive only — concise ideal answer",
    "keyPoints": ["for descriptive only — 2-4 strings"]
  }
]

Rules:
- Vary listeningExerciseType across items when the snippets support it.
- For type mcq: include exactly 4 options and correctAnswer 0-3.
- For type descriptive: use empty options; include modelAnswer and keyPoints.
- narrationText must stay faithful to snippet vocabulary and facts (paraphrase allowed).
- Keep narrationText under 900 characters per item.
- Inside JSON strings use \\n for line breaks — never raw newline or tab characters inside a string value`;

  const completion = await aiChatCompletion({
    model: getConfiguredChatModel(),
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.55,
    max_tokens: 4096,
  }, { operation: 'listening_grounded' });

  const text = completion.choices[0]?.message?.content?.trim();
  let rows;
  try {
    rows = parseAiJsonArray(text);
  } catch {
    throw new AiGenerationError('AI failed to generate listening question JSON', {
      code: 'AI_GENERATION_JSON_FAILED',
      kind: 'listening',
    });
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new AiGenerationError('No listening questions generated', { code: 'AI_GENERATION_EMPTY', kind: 'listening' });
  }
  return rows.slice(0, numQuestions).map((r) => normalizeListeningQuestion(r, subject, replayLimit));
};

const generateListeningUngrounded = async ({
  subject, numQuestions, difficulty, topics, contextText, replayLimit, seed, narrationStyle, additionalInstructions,
}) => {
  const topicText = topics?.length ? `Focus on: ${topics.join(', ')}.` : '';
  const ctx = contextText ? `\nOptional reference text (stay consistent if provided):\n"""\n${contextText.slice(0, 6000)}\n"""` : '';
  const styleLine = narrationStyleLine(narrationStyle);
  const extra = String(additionalInstructions || '').trim().slice(0, 2000);
  const extraBlock = extra ? `\nADDITIONAL INSTRUCTOR INSTRUCTIONS:\n${extra}\n` : '';
  const prompt = `You are an expert listening-exam author for schools and universities.

${styleLine}
${extraBlock}
Create exactly ${numQuestions} UNIQUE listening exercises for "${subject}" at ${difficulty} difficulty. ${topicText}${ctx}

Batch ID: ${seed}

Return ONLY a valid JSON array (no markdown):
[
  {
    "listeningExerciseType": "${LISTENING_EXERCISE_TYPES}",
    "type": "mcq or descriptive",
    "question": "On-screen prompt AFTER audio (not the narration itself)",
    "narrationText": "Professional educational narration to be spoken aloud (clear, natural; under 900 chars)",
    "audioTranscript": "Mirror narration or short transcript",
    "explanation": "Brief",
    "topic": "short label",
    "options": ["A. ...","B. ...","C. ...","D. ..."],
    "correctAnswer": 0,
    "modelAnswer": "descriptive only",
    "keyPoints": ["descriptive only"]
  }
]

Rules:
- If reference text is provided, do not contradict it.
- Vary exercise types.
- MCQ must have 4 options.
- Inside JSON strings use \\n for line breaks — never raw newline or tab characters inside a string value`;

  const completion = await aiChatCompletion({
    model: getConfiguredChatModel(),
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.75,
    max_tokens: 4096,
  }, { operation: 'listening_ungrounded' });
  const text = completion.choices[0]?.message?.content?.trim();
  let rows;
  try {
    rows = parseAiJsonArray(text);
  } catch {
    throw new AiGenerationError('AI failed to generate listening question JSON', {
      code: 'AI_GENERATION_JSON_FAILED',
      kind: 'listening',
    });
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new AiGenerationError('No listening questions generated', { code: 'AI_GENERATION_EMPTY', kind: 'listening' });
  }
  return rows.slice(0, numQuestions).map((r) => normalizeListeningQuestion(r, subject, replayLimit));
};

/**
 * @param {{ context?: string, contextText?: string, subject: string, numQuestions: number, difficulty?: string, topics?: string[], replayLimit?: number, grounded: boolean, narrationStyle?: string }} opts
 */
export const generateListeningExamQuestions = async (opts) => {
  const n = Math.max(1, Math.min(20, Number(opts.numQuestions) || 1));
  const seed = Math.floor(Math.random() * 10000);
  const subj = (opts.subject || 'General').trim() || 'General';
  const ctxStr = (opts.context || '').trim();
  const narrationStyle = opts.narrationStyle || 'academic';
  if (opts.grounded && ctxStr.length > 60) {
    return generateListeningFromGroundedSnippets({
      context: ctxStr,
      subject: subj,
      numQuestions: n,
      difficulty: opts.difficulty || 'medium',
      topics: opts.topics || [],
      replayLimit: opts.replayLimit,
      seed,
      narrationStyle,
    });
  }
  return generateListeningUngrounded({
    subject: subj,
    numQuestions: n,
    difficulty: opts.difficulty || 'medium',
    topics: opts.topics || [],
    contextText: opts.contextText || '',
    replayLimit: opts.replayLimit,
    seed,
    narrationStyle,
    additionalInstructions: opts.additionalInstructions,
  });
};

export const generateSingleListeningQuestion = async ({
  subject, difficulty, topics = [], contextText, groundedMode = false, replayLimit, existingQuestions = [],
  narrationStyle = 'academic',
}) => {
  const avoid = existingQuestions.slice(0, 6).map((q) => q.question).join('\n- ');
  const avoidText = avoid ? `\nAvoid duplicating:\n- ${avoid}` : '';
  const seed = Math.floor(Math.random() * 10000);
  const ctxCap = groundedMode ? 14_000 : 4000;
  const ctx = contextText?.trim()
    ? (groundedMode
      ? `\n${GROUNDED_RULES}\n\nSOURCE:\n"""\n${contextText.slice(0, ctxCap)}\n"""`
      : `\nReference:\n"""\n${contextText.slice(0, ctxCap)}\n"""`)
    : '';
  const styleLine = narrationStyleLine(narrationStyle);
  const prompt = `Create exactly 1 listening exercise for "${subject}", ${difficulty} difficulty.

${styleLine}
${avoidText}${ctx}

Batch ID: ${seed}

Return ONLY one JSON object:
{
  "listeningExerciseType": "${LISTENING_EXERCISE_TYPES}",
  "type": "mcq or descriptive",
  "question": "...",
  "narrationText": "...",
  "audioTranscript": "...",
  "explanation": "...",
  "topic": "...",
  "options": ["A. ...","B. ...","C. ...","D. ..."],
  "correctAnswer": 0,
  "modelAnswer": "...",
  "keyPoints": ["..."]
}

Inside JSON strings use \\n for line breaks — never raw newline or tab characters inside a string value`;

  const completion = await aiChatCompletion({
    model: getConfiguredChatModel(),
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.65,
    max_tokens: 1200,
  }, { operation: 'listening_single' });
  const text = completion.choices[0]?.message?.content?.trim();
  let raw;
  try {
    raw = parseAiJsonObject(text);
  } catch {
    throw new AiGenerationError('AI failed to generate listening question', {
      code: 'AI_GENERATION_JSON_FAILED',
      kind: 'listening',
    });
  }
  return normalizeListeningQuestion(raw, subject, replayLimit);
};

// ── AI Proctoring: analyze a webcam frame for violations ───────────────────
export const analyzeProctoringImage = async (base64Image) => {
  try {
    const response = await aiChatCompletion({
      model: getConfiguredVisionModel(),
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${base64Image}` },
          },
          {
            type: 'text',
            text: `You are an AI exam proctor analyzing a webcam screenshot. Be accurate and avoid false positives.

Analyze the image and return ONLY valid JSON (no markdown, no extra text):
{
  "faceCount": <integer: number of clearly visible human faces>,
  "phoneDetected": <boolean: is a mobile/smartphone clearly visible and being held or placed nearby>,
  "laptopDetected": <boolean: is there another laptop, external monitor, or secondary screen clearly visible besides the candidate's own screen>,
  "bookDetected": <boolean: are books, notebooks, printed notes, or study material clearly visible near the candidate>,
  "analysis": "<one concise sentence describing what you see>"
}

Rules:
- faceCount: count only clearly visible adult human faces
- phoneDetected: true only if a physical mobile phone is clearly present
- laptopDetected: true only if a second device/screen is clearly visible
- bookDetected: true only if study material is clearly visible and usable during the test
- When in doubt, return false to avoid false positives`,
          },
        ],
      }],
      max_tokens: 200,
      temperature: 0,
    }, { operation: 'proctoring_vision', skipHealthRecording: true });

    const raw = response.choices[0]?.message?.content?.trim() || '';
    let result;
    try {
      result = parseAiJsonObject(raw);
    } catch {
      return null;
    }
    return {
      faceCount:     typeof result.faceCount === 'number' ? result.faceCount : 1,
      phoneDetected: !!result.phoneDetected,
      laptopDetected:!!result.laptopDetected,
      bookDetected:  !!result.bookDetected,
      analysis:      result.analysis || '',
    };
  } catch (err) {
    // Vision API unavailable or model doesn't support vision — skip silently
    return null;
  }
};


