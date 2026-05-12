import Groq from 'groq-sdk';
import { parseAiJsonArray, parseAiJsonObject } from '../utils/aiJsonParse.js';

let _groq = null;
const getGroq = () => { if (!_groq) _groq = new Groq({ apiKey: process.env.GROQ_API_KEY }); return _groq; };

export const generateMCQs = async ({ subject, difficulty, numQuestions, topics }) => {
  const topicText = topics?.length ? `Focus on these topics: ${topics.join(', ')}.` : '';
  const seed = Math.floor(Math.random() * 10000);
  const prompt = `You are an expert exam question creator. Generate exactly ${numQuestions} UNIQUE multiple choice questions for the subject "${subject}" at ${difficulty} difficulty level. ${topicText}
Batch ID: ${seed} — use this to ensure variation across requests.

Return ONLY a valid JSON array, no markdown, no extra text:
[
  {
    "question": "...",
    "options": ["A. ...", "B. ...", "C. ...", "D. ..."],
    "correctAnswer": 0,
    "explanation": "...",
    "topic": "..."
  }
]

Rules:
- correctAnswer is the 0-based index (0=A, 1=B, 2=C, 3=D)
- All 4 options must be plausible distractors
- Questions must be distinct — no two questions should test the same concept
- Vary question types: recall, application, analysis, scenario-based
- Explanation must be concise and educational
- topic field: short label (2-4 words)
- Inside JSON strings use \\n for line breaks — never raw newline or tab characters inside a string value`;

  const completion = await getGroq().chat.completions.create({
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.85,
    max_tokens: 4096,
  });

  const text = completion.choices[0]?.message?.content?.trim();
  let questions;
  try {
    questions = parseAiJsonArray(text);
  } catch {
    throw new Error('AI failed to return valid JSON for MCQ questions');
  }
  if (!Array.isArray(questions) || questions.length === 0) throw new Error('No questions generated');

  return questions.map(q => ({
    type: 'mcq',
    question: q.question,
    options: Array.isArray(q.options) ? q.options : [],
    correctAnswer: Number(q.correctAnswer),
    explanation: q.explanation || '',
    topic: q.topic || subject,
  }));
};

/** Generate N coding questions in a single LLM call for efficiency */
export const generateCodingQuestions = async ({ subject, difficulty, numQuestions, topics }) => {
  const topicText = topics?.length ? `Focus on these topics: ${topics.join(', ')}.` : '';
  const seed = Math.floor(Math.random() * 10000);
  const prompt = `You are an expert coding interview question creator. Generate exactly ${numQuestions} UNIQUE coding challenge(s) for the subject "${subject}" at ${difficulty} difficulty. ${topicText}
Batch ID: ${seed} — each question must be different. Vary the problem types (algorithms, data structures, string manipulation, etc.).

Return ONLY a valid JSON array, no markdown, no extra text:
[
  {
    "question": "Clear problem statement with input/output requirements and example",
    "language": "javascript",
    "starterCode": "function solution(input) {\\n  // write your code here\\n}",
    "sampleSolution": "function solution(input) { /* working implementation */ }",
    "explanation": "Brief explanation of the approach",
    "topic": "short topic label"
  }
]

Rules:
- Each problem must be genuinely different
- starterCode must be a valid function skeleton in the specified language
- sampleSolution must be a real working solution
- question must include at least one example (input → output)
- Inside JSON strings use \\n for line breaks — never raw newline or tab characters inside a string value`;

  const completion = await getGroq().chat.completions.create({
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.8,
    max_tokens: 3000,
  });

  const text = completion.choices[0]?.message?.content?.trim();
  let questions;
  try {
    questions = parseAiJsonArray(text);
  } catch {
    throw new Error('AI failed to return valid JSON for coding questions');
  }
  if (!Array.isArray(questions) || questions.length === 0) throw new Error('No coding questions generated');

  return questions.map(q => ({
    type: 'coding',
    question: q.question || '',
    language: q.language || 'javascript',
    starterCode: q.starterCode || '',
    sampleSolution: q.sampleSolution || '',
    explanation: q.explanation || '',
    topic: q.topic || subject,
    options: [],
    correctAnswer: undefined,
  }));
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
    const completion = await getGroq().chat.completions.create({
      model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 300,
    });
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

/** Generate N descriptive (open-ended) questions */
export const generateDescriptiveQuestions = async ({ subject, difficulty, numQuestions, topics, contextText }) => {
  const topicText = topics?.length ? `Focus on these topics: ${topics.join(', ')}.` : '';
  const contextSection = contextText ? `\n\nBASE YOUR QUESTIONS STRICTLY ON THIS CONTENT:\n"""\n${contextText.slice(0, 6000)}\n"""` : '';
  const seed = Math.floor(Math.random() * 10000);
  const prompt = `You are an expert exam question creator. Generate exactly ${numQuestions} UNIQUE descriptive/open-ended questions for the subject "${subject}" at ${difficulty} difficulty. ${topicText}${contextSection}
Batch ID: ${seed}

Return ONLY a valid JSON array, no markdown, no extra text:
[
  {
    "question": "A clear, specific open-ended question that requires a written explanation",
    "modelAnswer": "A comprehensive model answer (3-5 sentences)",
    "keyPoints": ["key concept 1", "key concept 2", "key concept 3"],
    "explanation": "Why this question is important for this subject",
    "topic": "short topic label (2-4 words)"
  }
]

Rules:
- Questions must require substantive written answers (not yes/no)
- Each question must test a different concept
- modelAnswer should be a complete, well-structured response
- keyPoints: 2-4 essential concepts that a good answer should include
- Vary question types: explain, compare, analyze, evaluate, describe
- Inside JSON strings use \\n for line breaks — never raw newline or tab characters inside a string value`;

  const completion = await getGroq().chat.completions.create({
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.8,
    max_tokens: 4096,
  });

  const text = completion.choices[0]?.message?.content?.trim();
  let questions;
  try {
    questions = parseAiJsonArray(text);
  } catch {
    throw new Error('AI failed to return valid JSON for descriptive questions');
  }
  if (!Array.isArray(questions) || questions.length === 0) throw new Error('No questions generated');

  return questions.map(q => ({
    type: 'descriptive',
    question: q.question,
    modelAnswer: q.modelAnswer || '',
    keyPoints: Array.isArray(q.keyPoints) ? q.keyPoints : [],
    explanation: q.explanation || '',
    topic: q.topic || subject,
    options: [],
    correctAnswer: undefined,
  }));
};

/** Generate questions from uploaded content text (PDF/doc) — legacy full-document path */
export const generateQuestionsFromText = async ({
  text, numQuestions, examType = 'mcq', difficulty = 'medium', mixedMcqPercent = 50,
}) => {
  const truncated = text.slice(0, 8000); // limit context to avoid token overflow
  const seed = Math.floor(Math.random() * 10000);

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
      descCount > 0 ? generateDescriptiveQuestions({ subject: 'uploaded content', difficulty, numQuestions: descCount, topics: [], contextText: truncated }) : Promise.resolve([]),
      mcqCount > 0 ? generateMCQsFromText({ text: truncated, numQuestions: mcqCount, difficulty, seed }) : Promise.resolve([]),
    ]);
    return [...mcqs, ...desc];
  }
  return generateMCQsFromText({ text: truncated, numQuestions, difficulty, seed });
};

const GROUNDED_RULES = `MANDATORY CONSTRAINTS:
- Use ONLY facts, definitions, examples, and terminology that appear in SOURCE SNIPPETS below.
- Do NOT use outside knowledge, the open web, or information not explicitly supported by the snippets.
- Do NOT hallucinate names, numbers, dates, formulas, or claims.
- Every correct answer and every distractor must be consistent with the snippets (distractors may be subtle misunderstandings of the same material).
- If the snippets do not support enough distinct, high-quality questions, return FEWER than requested — never invent filler questions.
- Align difficulty with how deeply the snippets support reasoning vs recall.`;

const generateMCQsFromGroundedSnippets = async ({ context, subject, numQuestions, difficulty, seed, focusTopic }) => {
  const focusBlock = (focusTopic && String(focusTopic).trim())
    ? `

TEACHER PRIORITY: The question must target this concept (still only using facts supported by the snippets): "${String(focusTopic).trim()}"
Prefer snippets that clearly relate to this concept. If snippets barely relate, still stay grounded — do not invent outside material.`
    : '';
  const prompt = `You are an expert exam author for K-12 and higher-ed assessments.

${GROUNDED_RULES}
${focusBlock}

Difficulty level requested: ${difficulty}

Course / subject label (for tone only, not as a knowledge source): "${subject}"

SOURCE SNIPPETS (only source of truth):
"""
${context}
"""

Batch ID: ${seed}

Return ONLY a valid JSON array with at most ${numQuestions} objects, no markdown:
[
  {
    "question": "...",
    "options": ["A. ...", "B. ...", "C. ...", "D. ..."],
    "correctAnswer": 0,
    "explanation": "One sentence, citing which idea in the snippets the question tests",
    "topic": "short label from snippet vocabulary"
  }
]

Rules:
- correctAnswer is 0-based index (0=A)
- Inside JSON strings use \\n for line breaks — never raw newline or tab characters inside a string value`;

  const completion = await getGroq().chat.completions.create({
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.55,
    max_tokens: 4096,
  });

  const t = completion.choices[0]?.message?.content?.trim();
  let qs;
  try {
    qs = parseAiJsonArray(t);
  } catch {
    throw new Error('AI failed to generate grounded MCQ JSON');
  }
  if (!Array.isArray(qs) || qs.length === 0) throw new Error('No grounded questions generated');
  return qs.map(q => ({
    type: 'mcq',
    question: q.question,
    options: Array.isArray(q.options) ? q.options : [],
    correctAnswer: Number(q.correctAnswer),
    explanation: q.explanation || '',
    topic: q.topic || subject,
  }));
};

const generateDescriptiveFromGroundedSnippets = async ({ context, subject, numQuestions, difficulty, topics, seed }) => {
  const topicText = topics?.length ? `Topic hints (stay within snippets): ${topics.join(', ')}.` : '';
  const prompt = `You are an expert exam author.

${GROUNDED_RULES}

Difficulty: ${difficulty}
${topicText}
Course / subject label (tone only): "${subject}"

SOURCE SNIPPETS:
"""
${context}
"""

Batch ID: ${seed}

Return ONLY a valid JSON array with at most ${numQuestions} objects:
[
  {
    "question": "...",
    "modelAnswer": "Derived strictly from the snippets",
    "keyPoints": ["...", "..."],
    "explanation": "What this question checks in the material",
    "topic": "short label"
  }
]

Inside JSON strings use \\n for line breaks — never raw newline or tab characters inside a string value`;

  const completion = await getGroq().chat.completions.create({
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.55,
    max_tokens: 4096,
  });

  const text = completion.choices[0]?.message?.content?.trim();
  let questions;
  try {
    questions = parseAiJsonArray(text);
  } catch {
    throw new Error('AI failed to generate grounded descriptive JSON');
  }
  if (!Array.isArray(questions) || questions.length === 0) throw new Error('No grounded descriptive questions generated');

  return questions.map(q => ({
    type: 'descriptive',
    question: q.question,
    modelAnswer: q.modelAnswer || '',
    keyPoints: Array.isArray(q.keyPoints) ? q.keyPoints : [],
    explanation: q.explanation || '',
    topic: q.topic || subject,
    options: [],
    correctAnswer: undefined,
  }));
};

/**
 * RAG-backed generation: `context` must be retrieval-composed snippets only.
 */
export const generateGroundedExamQuestions = async ({
  context, subject, numQuestions, examType = 'mcq', difficulty = 'medium', mixedMcqPercent = 50, topics = [],
}) => {
  const ctx = (context || '').trim();
  if (ctx.length < 40) throw new Error('Insufficient retrieved material for grounded generation.');

  const subj = (subject || '').trim() || 'Uploaded study material';
  const seed = Math.floor(Math.random() * 10000);

  if (examType === 'descriptive') {
    return generateDescriptiveFromGroundedSnippets({
      context: ctx, subject: subj, numQuestions, difficulty, topics, seed,
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
    const [mcqs, desc] = await Promise.all([
      mcqCount > 0 ? generateMCQsFromGroundedSnippets({
        context: ctx, subject: subj, numQuestions: mcqCount, difficulty, seed: seed + 1,
      }) : Promise.resolve([]),
      descCount > 0 ? generateDescriptiveFromGroundedSnippets({
        context: ctx, subject: subj, numQuestions: descCount, difficulty, topics, seed: seed + 2,
      }) : Promise.resolve([]),
    ]);
    return [...mcqs, ...desc];
  }

  return generateMCQsFromGroundedSnippets({
    context: ctx, subject: subj, numQuestions, difficulty, seed,
  });
};

const generateMCQsFromText = async ({ text, numQuestions, difficulty, seed }) => {
  const prompt = `You are an expert exam creator. Generate exactly ${numQuestions} multiple choice questions STRICTLY based on the following content. Do NOT add any information not present in the content.
Batch ID: ${seed}

CONTENT:
"""
${text}
"""

Return ONLY a valid JSON array:
[
  {
    "question": "...",
    "options": ["A. ...", "B. ...", "C. ...", "D. ..."],
    "correctAnswer": 0,
    "explanation": "...",
    "topic": "..."
  }
]

Rules:
- ONLY use information from the provided content
- correctAnswer is 0-based index (0=A, 1=B, 2=C, 3=D)
- All 4 options must be plausible
- Difficulty: ${difficulty}
- Inside JSON strings use \\n for line breaks — never raw newline or tab characters inside a string value`;

  const completion = await getGroq().chat.completions.create({
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    max_tokens: 4096,
  });

  const t = completion.choices[0]?.message?.content?.trim();
  let qs;
  try {
    qs = parseAiJsonArray(t);
  } catch {
    throw new Error('AI failed to generate questions from content');
  }
  return qs.map(q => ({
    type: 'mcq',
    question: q.question,
    options: Array.isArray(q.options) ? q.options : [],
    correctAnswer: Number(q.correctAnswer),
    explanation: q.explanation || '',
    topic: q.topic || 'uploaded content',
  }));
};

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
}) => {
  const existing = existingQuestions.slice(0, 5).map(q => q.question).join('\n- ');
  const avoidText = existing ? `\nDo NOT generate a question similar to these:\n- ${existing}` : '';
  const ctxCap = groundedMode ? 14_000 : 3000;
  const contextSection = contextText ? `\n\nBase your question on this content:\n"""\n${contextText.slice(0, ctxCap)}\n"""` : '';
  const topicHint = topic ? ` The question must focus on: "${topic}".` : '';
  const guideLine = extraGuidance ? `\nTeacher notes (respect unless they conflict with grounded rules): ${String(extraGuidance).trim().slice(0, 600)}` : '';
  const styleLine = questionStyle === 'concept_check'
    ? '\nStyle: concise concept check (definitions, recognition, short stem).'
    : questionStyle === 'application'
      ? '\nStyle: short scenario or application stem appropriate to the level.'
      : '';
  const seed = Math.floor(Math.random() * 10000);
  const topicForLists = topic ? [String(topic).trim()] : [];

  if (examType === 'descriptive') {
    if (groundedMode && contextText?.trim()) {
      const topicHints = [...topicForLists, ...(extraGuidance ? [String(extraGuidance).trim().slice(0, 200)] : [])].filter(Boolean);
      const qs = await generateDescriptiveFromGroundedSnippets({
        subject, numQuestions: 1, difficulty, topics: topicHints.length ? topicHints : topicForLists, seed,
        context: contextText.slice(0, ctxCap),
      });
      return qs[0];
    }
    const qs = await generateDescriptiveQuestions({
      subject,
      difficulty,
      numQuestions: 1,
      topics: [...topicForLists, ...(extraGuidance ? [String(extraGuidance).trim().slice(0, 160)] : [])].filter(Boolean),
      contextText,
    });
    return qs[0];
  }
  if (examType === 'coding') {
    const tps = [...topicForLists];
    if (extraGuidance) tps.push(String(extraGuidance).trim().slice(0, 200));
    const qs = await generateCodingQuestions({
      subject, difficulty, numQuestions: 1, topics: tps.filter(Boolean).slice(0, 6),
    });
    return qs[0];
  }

  if (groundedMode && contextText?.trim()) {
    const qs = await generateMCQsFromGroundedSnippets({
      context: contextText.slice(0, ctxCap),
      subject,
      numQuestions: 1,
      difficulty,
      seed,
      focusTopic: topic || undefined,
    });
    return qs[0];
  }

  // MCQ (generic)
  const prompt = `Generate exactly 1 unique MCQ for subject "${subject}", difficulty "${difficulty}".${topicHint}${guideLine}${styleLine}${avoidText}${contextSection}
Batch ID: ${seed}

Return ONLY a single JSON object (not an array):
{
  "question": "...",
  "options": ["A. ...", "B. ...", "C. ...", "D. ..."],
  "correctAnswer": 0,
  "explanation": "...",
  "topic": "..."
}

Inside JSON strings use \\n for line breaks — never raw newline or tab characters inside a string value.`;

  const completion = await getGroq().chat.completions.create({
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.9,
    max_tokens: 512,
  });

  const text = completion.choices[0]?.message?.content?.trim();
  let q;
  try {
    q = parseAiJsonObject(text);
  } catch {
    throw new Error('AI failed to generate replacement question');
  }
  return {
    type: 'mcq',
    question: q.question,
    options: Array.isArray(q.options) ? q.options : [],
    correctAnswer: Number(q.correctAnswer),
    explanation: q.explanation || '',
    topic: q.topic || subject,
  };
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
    const completion = await getGroq().chat.completions.create({
      model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 200,
    });
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

  const completion = await getGroq().chat.completions.create({
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.5,
    max_tokens: 256,
  });

  const text = completion.choices[0]?.message?.content?.trim();
  try {
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

  const completion = await getGroq().chat.completions.create({
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.55,
    max_tokens: 4096,
  });

  const text = completion.choices[0]?.message?.content?.trim();
  let rows;
  try {
    rows = parseAiJsonArray(text);
  } catch {
    throw new Error('AI failed to generate listening question JSON');
  }
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('No listening questions generated');
  return rows.slice(0, numQuestions).map((r) => normalizeListeningQuestion(r, subject, replayLimit));
};

const generateListeningUngrounded = async ({
  subject, numQuestions, difficulty, topics, contextText, replayLimit, seed, narrationStyle,
}) => {
  const topicText = topics?.length ? `Focus on: ${topics.join(', ')}.` : '';
  const ctx = contextText ? `\nOptional reference text (stay consistent if provided):\n"""\n${contextText.slice(0, 6000)}\n"""` : '';
  const styleLine = narrationStyleLine(narrationStyle);
  const prompt = `You are an expert listening-exam author for schools and universities.

${styleLine}

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

  const completion = await getGroq().chat.completions.create({
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.75,
    max_tokens: 4096,
  });
  const text = completion.choices[0]?.message?.content?.trim();
  let rows;
  try {
    rows = parseAiJsonArray(text);
  } catch {
    throw new Error('AI failed to generate listening question JSON');
  }
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('No listening questions generated');
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

  const completion = await getGroq().chat.completions.create({
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.65,
    max_tokens: 1200,
  });
  const text = completion.choices[0]?.message?.content?.trim();
  let raw;
  try {
    raw = parseAiJsonObject(text);
  } catch {
    throw new Error('AI failed to generate listening question');
  }
  return normalizeListeningQuestion(raw, subject, replayLimit);
};

// ── AI Proctoring: analyze a webcam frame for violations ───────────────────
// Uses Groq vision model to detect faces, phones, laptops, etc.
export const analyzeProctoringImage = async (base64Image) => {
  const VISION_MODEL = process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
  try {
    const response = await getGroq().chat.completions.create({
      model: VISION_MODEL,
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
    });

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


