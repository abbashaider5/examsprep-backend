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
