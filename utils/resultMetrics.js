/**
 * Recompute result totals from exam questions and stored answer documents.
 * Mirrors scoring rules in resultController.submitResult.
 */
export function computeResultMetrics(exam, answers) {
  const questions = exam.questions || [];
  const total = questions.length;
  let correctCount = 0;
  let unattemptedCount = 0;
  const byIndex = Object.fromEntries((answers || []).map(a => [a.questionIndex, a]));

  for (let idx = 0; idx < total; idx++) {
    const q = questions[idx];
    const a = byIndex[idx];
    const qType = q?.type || 'mcq';
    if (!a) {
      unattemptedCount++;
      continue;
    }
    if (qType === 'mcq') {
      const noAnswer = a.selectedOption === null || a.selectedOption === undefined;
      if (noAnswer) unattemptedCount++;
      else if (a.isCorrect) correctCount++;
    } else {
      if (a.isCorrect) correctCount++;
    }
  }

  const incorrectCount = total - correctCount - unattemptedCount;
  const percentage = total ? Math.round((correctCount / total) * 100) : 0;
  const passThreshold = exam.passingPercentage ?? 75;
  const passed = percentage >= passThreshold;

  const topicMap = {};
  for (const ans of answers || []) {
    const q = questions[ans.questionIndex];
    if (!q) continue;
    const t = q.topic || 'General';
    if (!topicMap[t]) topicMap[t] = { correct: 0, total: 0 };
    topicMap[t].total++;
    if (ans.isCorrect) topicMap[t].correct++;
  }
  const topicAccuracy = {};
  for (const [t, v] of Object.entries(topicMap)) {
    topicAccuracy[t] = Math.round((v.correct / v.total) * 100);
  }

  return {
    correctCount,
    incorrectCount,
    unattemptedCount,
    percentage,
    passed,
    score: correctCount,
    totalQuestions: total,
    topicAccuracy,
  };
}
