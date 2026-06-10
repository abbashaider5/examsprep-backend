import ExamInvite from '../models/ExamInvite.js';
import Result from '../models/Result.js';
import Screenshot from '../models/Screenshot.js';
import User from '../models/User.js';

/**
 * Same row + summary construction as GET /api/instructor/exams/:examId/report.
 * @param {import('mongoose').Document} exam — must include _id and screenshotEnabled
 */
export async function buildInstructorExamReportData(exam) {
  const invites = await ExamInvite.find({ exam: exam._id })
    .populate({
      path: 'result',
      select: 'score totalQuestions correctCount incorrectCount percentage passed timeTaken proctored violations topicAccuracy createdAt proctoringEvents',
    })
    .sort({ createdAt: -1 });

  const allResults = await Result.find({ exam: exam._id })
    .populate('user', 'name email')
    .sort({ createdAt: 1 });

  const resultsByUser = {};
  allResults.forEach((r) => {
    if (!r.user) return;
    const uid = r.user._id.toString();
    if (!resultsByUser[uid]) resultsByUser[uid] = [];
    resultsByUser[uid].push(r);
  });

  const screenshotCounts = exam.screenshotEnabled
    ? await Screenshot.aggregate([
        { $match: { exam: exam._id } },
        { $group: { _id: '$user', count: { $sum: 1 } } },
      ])
    : [];
  const screenshotMap = Object.fromEntries(screenshotCounts.map((s) => [s._id.toString(), s.count]));

  const inviteEmailSet = new Set(invites.map((inv) => inv.email));
  const inviteUsers = await User.find({ email: { $in: [...inviteEmailSet] } }).select('email name');
  const inviteUserByEmail = Object.fromEntries(inviteUsers.map((u) => [u.email, u]));

  const buildRow = (email, name, uid, inv) => {
    const userResults = uid ? (resultsByUser[uid] || []) : [];
    const latestResult = userResults[userResults.length - 1] || null;
    const bestResult = userResults.reduce((best, r) => (!best || r.percentage > best.percentage ? r : best), null);
    return {
      _id: inv?._id || uid,
      userId: uid || null,
      email,
      name: name || null,
      inviteStatus: inv?.status || 'batch',
      enrollmentSource: inv?.enrollmentSource || 'normal',
      invitedAt: inv?.createdAt || null,
      reattemptCount: inv?.reattemptCount || 0,
      totalAttempts: userResults.length,
      screenshotCount: uid ? (screenshotMap[uid] || 0) : 0,
      latestResult: latestResult
        ? {
            resultId: latestResult._id,
            score: latestResult.score,
            totalQuestions: latestResult.totalQuestions,
            correctCount: latestResult.correctCount,
            incorrectCount: latestResult.incorrectCount,
            percentage: latestResult.percentage,
            passed: latestResult.passed,
            timeTaken: latestResult.timeTaken,
            proctored: latestResult.proctored,
            violations: latestResult.violations,
            attemptedAt: latestResult.createdAt,
            topicAccuracy: latestResult.topicAccuracy ? Object.fromEntries(latestResult.topicAccuracy) : {},
            proctoringEvents: Array.isArray(latestResult.proctoringEvents) ? latestResult.proctoringEvents : [],
          }
        : null,
      bestResult: bestResult
        ? {
            percentage: bestResult.percentage,
            passed: bestResult.passed,
            attemptedAt: bestResult.createdAt,
          }
        : null,
      allAttempts: userResults.map((r) => ({
        resultId: r._id,
        percentage: r.percentage,
        passed: r.passed,
        timeTaken: r.timeTaken,
        violations: r.violations,
        proctoringEvents: Array.isArray(r.proctoringEvents) ? r.proctoringEvents : [],
        proctored: r.proctored,
        attemptedAt: r.createdAt,
      })),
    };
  };

  const rows = invites.map((inv) => {
    const userInfo = inviteUserByEmail[inv.email];
    const uid = userInfo?._id?.toString();
    return buildRow(inv.email, userInfo?.name, uid, inv);
  });

  const invitedUserIds = new Set(inviteUsers.map((u) => u._id.toString()));
  const batchOnlyUsers = new Set();
  allResults.forEach((r) => {
    if (!r.user) return;
    const uid = r.user._id.toString();
    if (!invitedUserIds.has(uid) && !batchOnlyUsers.has(uid)) {
      batchOnlyUsers.add(uid);
      rows.push(buildRow(r.user.email, r.user.name, uid, null));
    }
  });

  const attempted = rows.filter((r) => r.totalAttempts > 0);
  const passedLatest = rows.filter((r) => r.latestResult?.passed).length;
  const failedLatest = rows.filter((r) => r.latestResult && !r.latestResult.passed).length;
  const summary = {
    totalInvites: invites.length,
    pending: invites.filter((i) => i.status === 'pending').length,
    totalParticipants: rows.length,
    attempted: attempted.length,
    passed: passedLatest,
    failed: failedLatest,
    avgScore: attempted.length
      ? Math.round(attempted.reduce((s, r) => s + r.latestResult.percentage, 0) / attempted.length)
      : 0,
    totalSubmissions: allResults.length,
  };

  return { rows, summary };
}
