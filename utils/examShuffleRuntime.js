import crypto from 'crypto';

/** @param {number} n */
export function fisherYatesIndices(n) {
  const arr = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * One full shuffle: question order + per-question MCQ option shuffle (correctAnswer remapped).
 * @param {object[]} questions
 */
export function shuffleQuestionSetOnce(questions) {
  const base = JSON.parse(JSON.stringify(questions));
  const order = fisherYatesIndices(base.length);
  return order.map((i) => {
    const q = JSON.parse(JSON.stringify(base[i]));
    if (q.type === 'mcq' && Array.isArray(q.options) && q.options.length >= 2) {
      const m = q.options.length;
      const perm = fisherYatesIndices(m);
      const opts = [...q.options];
      q.options = perm.map((oldI) => opts[oldI]);
      const oldCorrect = base[i].correctAnswer;
      if (oldCorrect != null && oldCorrect >= 0 && oldCorrect < m) {
        q.correctAnswer = perm.indexOf(oldCorrect);
      }
    }
    return q;
  });
}

/**
 * Build 3 distinct variants from the same canonical question list.
 * @param {object[]} questions
 */
export function buildThreeQuestionVariants(questions) {
  return [0, 1, 2].map(() => shuffleQuestionSetOnce(questions));
}

/**
 * @param {import('mongoose').Document | object} exam
 * @param {number} variantIndex
 */
export function getBaseQuestionsForExam(exam, variantIndex) {
  const ex = exam.toObject ? exam.toObject() : exam;
  if (
    ex.multipleSets
    && Array.isArray(ex.questionVariants)
    && ex.questionVariants.length > 0
  ) {
    const idx = Math.min(
      Math.max(0, variantIndex),
      ex.questionVariants.length - 1,
    );
    return JSON.parse(JSON.stringify(ex.questionVariants[idx]));
  }
  return JSON.parse(JSON.stringify(ex.questions || []));
}

/**
 * Per-user shuffle on top of variant (question order + MCQ option permutations per display slot).
 * @param {object[]} baseQuestions canonical list for this student (one variant)
 */
export function createUserShuffleState(baseQuestions) {
  const n = baseQuestions.length;
  const questionOrder = fisherYatesIndices(n);
  const optionPermutations = questionOrder.map((canonicalIdx) => {
    const q = baseQuestions[canonicalIdx];
    if (q.type === 'mcq' && Array.isArray(q.options) && q.options.length >= 2) {
      return fisherYatesIndices(q.options.length);
    }
    return null;
  });
  return { questionOrder, optionPermutations };
}

/**
 * @param {object[]} baseQuestions
 * @param {{ questionOrder: number[], optionPermutations: (number[]|null)[] }} shuffle
 */
export function buildDisplayQuestions(baseQuestions, shuffle) {
  const { questionOrder, optionPermutations } = shuffle;
  return questionOrder.map((canonicalIdx, displayIdx) => {
    const raw = baseQuestions[canonicalIdx];
    const q = JSON.parse(JSON.stringify(raw));
    const perm = optionPermutations[displayIdx];
    if (
      q.type === 'mcq'
      && perm
      && Array.isArray(q.options)
      && perm.length === q.options.length
    ) {
      const oldOpts = [...q.options];
      q.options = perm.map((oldI) => oldOpts[oldI]);
      const oldCorrect = raw.correctAnswer;
      if (oldCorrect != null && oldCorrect >= 0 && oldCorrect < oldOpts.length) {
        q.correctAnswer = perm.indexOf(oldCorrect);
      }
    }
    return q;
  });
}
