import Groq from 'groq-sdk';

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
- topic field: short label (2-4 words)`;

  const completion = await getGroq().chat.completions.create({
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.85,
    max_tokens: 4096,
  });

  const text = completion.choices[0]?.message?.content?.trim();
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('AI failed to return valid JSON for MCQ questions');

  const questions = JSON.parse(jsonMatch[0]);
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
- question must include at least one example (input → output)`;

  const completion = await getGroq().chat.completions.create({
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.8,
    max_tokens: 3000,
  });

  const text = completion.choices[0]?.message?.content?.trim();
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('AI failed to return valid JSON for coding questions');

  const questions = JSON.parse(jsonMatch[0]);
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
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { isCorrect: false, score: 0, feedback: 'Evaluation could not be completed.' };
    const result = JSON.parse(jsonMatch[0]);
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
- Vary question types: explain, compare, analyze, evaluate, describe`;

  const completion = await getGroq().chat.completions.create({
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.8,
    max_tokens: 4096,
  });

  const text = completion.choices[0]?.message?.content?.trim();
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('AI failed to return valid JSON for descriptive questions');

  const questions = JSON.parse(jsonMatch[0]);
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

/** Generate questions from uploaded content text (PDF/doc) */
export const generateQuestionsFromText = async ({ text, numQuestions, examType = 'mcq', difficulty = 'medium' }) => {
  const truncated = text.slice(0, 8000); // limit context to avoid token overflow
  const seed = Math.floor(Math.random() * 10000);

  if (examType === 'descriptive' || examType === 'mixed') {
    const descCount = examType === 'mixed' ? Math.ceil(numQuestions / 2) : numQuestions;
    const mcqCount = examType === 'mixed' ? numQuestions - descCount : 0;
    const [desc, mcqs] = await Promise.all([
      descCount > 0 ? generateDescriptiveQuestions({ subject: 'uploaded content', difficulty, numQuestions: descCount, topics: [], contextText: truncated }) : Promise.resolve([]),
      mcqCount > 0 ? generateMCQsFromText({ text: truncated, numQuestions: mcqCount, difficulty, seed }) : Promise.resolve([]),
    ]);
    return [...mcqs, ...desc];
  }
  return generateMCQsFromText({ text: truncated, numQuestions, difficulty, seed });
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
- Difficulty: ${difficulty}`;

  const completion = await getGroq().chat.completions.create({
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    max_tokens: 4096,
  });

  const t = completion.choices[0]?.message?.content?.trim();
  const match = t.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('AI failed to generate questions from content');
  const qs = JSON.parse(match[0]);
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
export const generateSingleQuestion = async ({ subject, difficulty, examType = 'mcq', existingQuestions = [], topic, contextText }) => {
  const existing = existingQuestions.slice(0, 5).map(q => q.question).join('\n- ');
  const avoidText = existing ? `\nDo NOT generate a question similar to these:\n- ${existing}` : '';
  const contextSection = contextText ? `\n\nBase your question on this content:\n"""\n${contextText.slice(0, 3000)}\n"""` : '';
  const topicHint = topic ? ` The question should be about "${topic}".` : '';
  const seed = Math.floor(Math.random() * 10000);

  if (examType === 'descriptive') {
    const qs = await generateDescriptiveQuestions({ subject, difficulty, numQuestions: 1, topics: topic ? [topic] : [], contextText });
    return qs[0];
  }
  if (examType === 'coding') {
    const qs = await generateCodingQuestions({ subject, difficulty, numQuestions: 1, topics: topic ? [topic] : [] });
    return qs[0];
  }

  // MCQ
  const prompt = `Generate exactly 1 unique MCQ for subject "${subject}", difficulty "${difficulty}".${topicHint}${avoidText}${contextSection}
Batch ID: ${seed}

Return ONLY a single JSON object (not an array):
{
  "question": "...",
  "options": ["A. ...", "B. ...", "C. ...", "D. ..."],
  "correctAnswer": 0,
  "explanation": "...",
  "topic": "..."
}`;

  const completion = await getGroq().chat.completions.create({
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.9,
    max_tokens: 512,
  });

  const text = completion.choices[0]?.message?.content?.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('AI failed to generate replacement question');
  const q = JSON.parse(jsonMatch[0]);
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
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { isCorrect: false, score: 0, feedback: 'Evaluation unavailable.' };
    const result = JSON.parse(jsonMatch[0]);
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
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  return JSON.parse(jsonMatch[0]);
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
    const jsonMatch = raw.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return null;

    const result = JSON.parse(jsonMatch[0]);
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


