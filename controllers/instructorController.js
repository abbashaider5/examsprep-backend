import { AppError } from '../middleware/errorHandler.js';
import Exam from '../models/Exam.js';
import ExamInvite from '../models/ExamInvite.js';
import Group from '../models/Group.js';
import Result from '../models/Result.js';
import Screenshot from '../models/Screenshot.js';
import User from '../models/User.js';
import { getSettings } from '../models/SystemSettings.js';
import { sendInstructorInviteEmail } from '../services/emailService.js';
import { fromReq, log } from '../utils/activityLogger.js';
import logger from '../utils/logger.js';

// POST /api/instructor/become
export const becomeInstructor = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    if (user.role === 'instructor') return res.json({ message: 'Already an instructor', role: 'instructor' });
    if (user.role === 'admin') return next(new AppError('Admins cannot change role', 400));

    if (user.getEffectivePlan() === 'free') {
      return next(new AppError('Active premium plan required to become an instructor.', 403));
    }

    user.role = 'instructor';
    await user.save({ validateBeforeSave: false });

    await log({ user, action: 'became_instructor', category: 'profile', ...fromReq(req) });
    res.json({ message: 'You are now an instructor!', role: 'instructor' });
  } catch (err) { next(err); }
};

// GET /api/instructor/exams
export const getMyExams = async (req, res, next) => {
  try {
    const exams = await Exam.find({ createdBy: req.user._id }).sort({ createdAt: -1 });
    const examIds = exams.map(e => e._id);

    const inviteCounts = await ExamInvite.aggregate([
      { $match: { exam: { $in: examIds } } },
      { $group: { _id: '$exam', total: { $sum: 1 }, accepted: { $sum: { $cond: [{ $eq: ['$status', 'accepted'] }, 1, 0] } } } }
    ]);
    const inviteMap = Object.fromEntries(inviteCounts.map(i => [i._id.toString(), i]));

    const examsWithStats = exams.map(e => ({
      ...e.toObject(),
      inviteCount: inviteMap[e._id.toString()]?.total || 0,
      acceptedCount: inviteMap[e._id.toString()]?.accepted || 0,
    }));

    res.json({ exams: examsWithStats });
  } catch (err) { next(err); }
};

// POST /api/instructor/exams/:examId/invite
export const sendInvite = async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return next(new AppError('Email is required', 400));

    const exam = await Exam.findOne({ _id: req.params.examId, createdBy: req.user._id });
    if (!exam) return next(new AppError('Exam not found or unauthorized', 404));

    const existing = await ExamInvite.findOne({ exam: exam._id, email, status: { $ne: 'expired' } });
    if (existing) return next(new AppError('This email has already been invited', 409));

    const invite = await ExamInvite.create({ exam: exam._id, invitedBy: req.user._id, email });
    const inviteUrl = `${process.env.CLIENT_URL || 'http://localhost:5173'}/exam/${exam._id}?invite=${invite.token}`;

    const settings = await getSettings();
    if (settings.emailInstructorInviteEnabled) {
      sendInstructorInviteEmail({
        email,
        instructorName: req.user.name,
        examTitle: exam.title,
        examSubject: exam.subject,
        inviteUrl,
        expiresAt: invite.expiresAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }),
      }).catch(logger.error);
    }

    res.status(201).json({ message: 'Invite sent successfully', invite });
  } catch (err) { next(err); }
};

// GET /api/instructor/exams/:examId/invites
export const getExamInvites = async (req, res, next) => {
  try {
    const exam = await Exam.findOne({ _id: req.params.examId, createdBy: req.user._id });
    if (!exam) return next(new AppError('Exam not found or unauthorized', 404));

    const invites = await ExamInvite.find({ exam: req.params.examId })
      .populate('result', 'percentage score passed timeTaken createdAt')
      .sort({ createdAt: -1 });

    res.json({ invites, exam });
  } catch (err) { next(err); }
};

// GET /api/instructor/exams/:examId/screenshots
export const getExamScreenshots = async (req, res, next) => {
  try {
    const exam = await Exam.findOne({ _id: req.params.examId, createdBy: req.user._id }).select('_id title');
    if (!exam) return next(new AppError('Exam not found or unauthorized', 404));

    const screenshots = await Screenshot.find({ exam: exam._id })
      .populate('user', 'name email')
      .populate('result', 'percentage passed violations')
      .sort({ capturedAt: -1 })
      .limit(100);

    res.json({ screenshots, exam });
  } catch (err) { next(err); }
};

// GET /api/instructor/analytics
export const getInstructorAnalytics = async (req, res, next) => {
  try {
    const exams = await Exam.find({ createdBy: req.user._id }).sort({ createdAt: -1 });
    const examIds = exams.map(e => e._id);

    const [inviteStats, resultStats] = await Promise.all([
      ExamInvite.aggregate([
        { $match: { exam: { $in: examIds } } },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]),
      Result.aggregate([
        { $match: { exam: { $in: examIds } } },
        { $group: { _id: '$exam', count: { $sum: 1 }, avgScore: { $avg: '$percentage' }, passCount: { $sum: { $cond: ['$passed', 1, 0] } } } }
      ]),
    ]);

    const inviteStatusMap = Object.fromEntries(inviteStats.map(i => [i._id, i.count]));
    const resultMap = Object.fromEntries(resultStats.map(r => [r._id.toString(), r]));

    const totalInvites = (inviteStatusMap.pending || 0) + (inviteStatusMap.accepted || 0) + (inviteStatusMap.expired || 0);
    const acceptedInvites = inviteStatusMap.accepted || 0;
    const totalAttempts = resultStats.reduce((a, r) => a + r.count, 0);
    const avgScore = resultStats.length ? Math.round(resultStats.reduce((a, r) => a + r.avgScore, 0) / resultStats.length) : 0;

    const examsWithStats = exams.map(e => ({
      _id: e._id, title: e.title, subject: e.subject,
      difficulty: e.difficulty, timesAttempted: e.timesAttempted,
      proctored: e.proctored, certificate: e.certificate,
      allowReattempt: e.allowReattempt, showAnswersAfter: e.showAnswersAfter,
      passingPercentage: e.passingPercentage, expiryDate: e.expiryDate,
      questions: e.questions, questionCount: e.questions?.length || 0,
      inviteCount: 0, acceptedCount: 0,
      stats: resultMap[e._id.toString()] || { count: 0, avgScore: 0, passCount: 0 },
    }));

    res.json({ totalExams: exams.length, totalInvites, acceptedInvites, totalAttempts, avgScore, exams: examsWithStats });
  } catch (err) { next(err); }
};

// GET /api/instructor/analytics/detailed
export const getDetailedAnalytics = async (req, res, next) => {
  try {
    const exams = await Exam.find({ createdBy: req.user._id }).sort({ createdAt: -1 }).lean();
    const examIds = exams.map(e => e._id);

    // All results for instructor's exams with user info
    const results = await Result.find({ exam: { $in: examIds } })
      .populate('user', 'name email')
      .sort({ createdAt: -1 })
      .lean();

    // Time series — results per day last 30 days
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const timeSeries = await Result.aggregate([
      { $match: { exam: { $in: examIds }, createdAt: { $gte: thirtyDaysAgo } } },
      {
        $group: {
          _id:      { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          attempts: { $sum: 1 },
          avgScore: { $avg: '$percentage' },
          passed:   { $sum: { $cond: ['$passed', 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Subject breakdown (pass rate by subject)
    const subjectBreakdown = await Result.aggregate([
      { $match: { exam: { $in: examIds } } },
      { $lookup: { from: 'exams', localField: 'exam', foreignField: '_id', as: 'examData' } },
      { $unwind: '$examData' },
      {
        $group: {
          _id:       '$examData.subject',
          count:     { $sum: 1 },
          avgScore:  { $avg: '$percentage' },
          passCount: { $sum: { $cond: ['$passed', 1, 0] } },
        },
      },
      { $sort: { count: -1 } },
    ]);

    // Per-exam stats
    const examMap = Object.fromEntries(exams.map(e => [e._id.toString(), e]));
    const examStatsMap = {};
    for (const r of results) {
      const eid = r.exam.toString();
      if (!examStatsMap[eid]) examStatsMap[eid] = { count: 0, total: 0, pass: 0 };
      examStatsMap[eid].count++;
      examStatsMap[eid].total += r.percentage;
      if (r.passed) examStatsMap[eid].pass++;
    }
    const examStats = exams.map(e => {
      const s = examStatsMap[e._id.toString()] || { count: 0, total: 0, pass: 0 };
      return {
        _id: e._id, title: e.title, subject: e.subject, difficulty: e.difficulty,
        attempts:  s.count,
        avgScore:  s.count ? Math.round(s.total / s.count) : 0,
        passCount: s.pass,
        passRate:  s.count ? Math.round((s.pass / s.count) * 100) : 0,
        createdAt: e.createdAt,
      };
    });

    // Per-student performance
    const studentMap = {};
    for (const r of results) {
      const uid = r.user?._id?.toString();
      if (!uid) continue;
      if (!studentMap[uid]) {
        studentMap[uid] = {
          user:     { _id: r.user._id, name: r.user.name, email: r.user.email },
          attempts: 0, totalScore: 0, passCount: 0, exams: [],
        };
      }
      studentMap[uid].attempts++;
      studentMap[uid].totalScore += r.percentage;
      if (r.passed) studentMap[uid].passCount++;
      studentMap[uid].exams.push({
        examId:    r.exam,
        examTitle: examMap[r.exam.toString()]?.title || 'Unknown',
        score:     r.percentage,
        passed:    r.passed,
        timeTaken: r.timeTaken,
        date:      r.createdAt,
      });
    }
    const studentPerformance = Object.values(studentMap)
      .map(s => ({
        ...s,
        avgScore: s.attempts > 0 ? Math.round(s.totalScore / s.attempts) : 0,
        passRate: s.attempts > 0 ? Math.round((s.passCount / s.attempts) * 100) : 0,
      }))
      .sort((a, b) => b.avgScore - a.avgScore);

    const totalAttempts  = results.length;
    const overallAvg     = totalAttempts ? Math.round(results.reduce((a, r) => a + r.percentage, 0) / totalAttempts) : 0;
    const overallPass    = totalAttempts ? Math.round((results.filter(r => r.passed).length / totalAttempts) * 100) : 0;

    // Group-wise performance
    const instructorGroups = await Group.find({ instructor: req.user._id }).lean();
    const groupPerformance = instructorGroups.map(g => {
      const memberIds = (g.members || []).map(id => id.toString());
      const groupStudents = studentPerformance.filter(s => memberIds.includes(s.user._id.toString()));
      const groupAttempts = groupStudents.reduce((a, s) => a + s.attempts, 0);
      const groupAvg = groupStudents.length > 0
        ? Math.round(groupStudents.reduce((a, s) => a + s.avgScore, 0) / groupStudents.length)
        : 0;
      const groupPassRate = groupStudents.length > 0
        ? Math.round(groupStudents.reduce((a, s) => a + s.passRate, 0) / groupStudents.length)
        : 0;
      return {
        _id: g._id,
        name: g.name,
        memberCount: g.members?.length || 0,
        activeStudents: groupStudents.length,
        totalAttempts: groupAttempts,
        avgScore: groupAvg,
        passRate: groupPassRate,
        students: groupStudents,
      };
    });

    res.json({
      summary: {
        totalExams:    exams.length,
        totalAttempts,
        avgScore:      overallAvg,
        passRate:      overallPass,
        totalStudents: Object.keys(studentMap).length,
      },
      examStats,
      timeSeries,
      subjectBreakdown,
      studentPerformance,
      groupPerformance,
    });
  } catch (err) { next(err); }
};
export const sendGroupInvite = async (req, res, next) => {
  try {
    const { groupId } = req.body;
    if (!groupId) return next(new AppError('groupId is required', 400));

    const exam = await Exam.findOne({ _id: req.params.examId, createdBy: req.user._id });
    if (!exam) return next(new AppError('Exam not found or unauthorized', 404));

    const group = await Group.findById(groupId).populate('members', 'email name');
    if (!group) return next(new AppError('Group not found', 404));
    if (group.instructor.toString() !== req.user._id.toString()) {
      return next(new AppError('Not your group', 403));
    }

    const emails = group.members.map(m => m.email);
    const settings = await getSettings();
    const inviteUrl = `${process.env.CLIENT_URL || 'http://localhost:5173'}/exam/${exam._id}`;

    let sent = 0, skipped = 0;
    for (const email of emails) {
      const existing = await ExamInvite.findOne({ exam: exam._id, email, status: { $ne: 'expired' } });
      if (existing) { skipped++; continue; }
      const invite = await ExamInvite.create({ exam: exam._id, invitedBy: req.user._id, email, group: groupId });
      sent++;
      if (settings.emailInstructorInviteEnabled) {
        const member = group.members.find(m => m.email === email);
        sendInstructorInviteEmail({
          email,
          instructorName: req.user.name,
          examTitle: exam.title,
          examSubject: exam.subject,
          inviteUrl: `${inviteUrl}?invite=${invite.token}`,
          expiresAt: invite.expiresAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }),
        }).catch(logger.error);
      }
    }

    res.json({ message: `Invites sent to ${sent} member${sent !== 1 ? 's' : ''}. ${skipped} already invited.`, sent, skipped });
  } catch (err) { next(err); }
};
export const acceptInvite = async (req, res, next) => {
  try {
    const invite = await ExamInvite.findOne({ token: req.params.token })
      .populate('exam', 'title subject difficulty proctored questions');

    if (!invite) return next(new AppError('Invalid invite link', 404));
    if (invite.expiresAt < new Date()) {
      invite.status = 'expired';
      await invite.save();
      return next(new AppError('This invite link has expired', 410));
    }
    if (invite.status === 'accepted') {
      return res.json({ message: 'Invite already accepted', exam: invite.exam });
    }
    if (req.user.email.toLowerCase() !== invite.email.toLowerCase()) {
      return next(new AppError('This invite was sent to a different email address', 403));
    }

    invite.status = 'accepted';
    await invite.save();

    res.json({ message: 'Invite accepted', exam: invite.exam });
  } catch (err) { next(err); }
};

// GET /api/instructor/invite/:token/validate — public
export const validateInviteToken = async (req, res, next) => {
  try {
    const invite = await ExamInvite.findOne({ token: req.params.token })
      .populate('exam', 'title subject difficulty questions proctored')
      .populate('invitedBy', 'name');

    if (!invite) return next(new AppError('Invalid invite link', 404));
    if (invite.expiresAt < new Date()) {
      invite.status = 'expired';
      await invite.save();
      return next(new AppError('This invite link has expired', 410));
    }

    res.json({ valid: true, invite });
  } catch (err) { next(err); }
};

// GET /api/instructor/my-invites
export const getMyPendingInvites = async (req, res, next) => {
  try {
    const invites = await ExamInvite.find({
      email: req.user.email.toLowerCase(),
      status: 'pending',
      expiresAt: { $gt: new Date() },
    })
      .populate('exam', 'title subject difficulty questions proctored timePerQuestion')
      .populate('invitedBy', 'name')
      .sort({ createdAt: -1 });
    res.json({ invites });
  } catch (err) { next(err); }
};

// GET /api/instructor/my-accepted-invites
export const getMyAcceptedInvites = async (req, res, next) => {
  try {
    const invites = await ExamInvite.find({
      email: req.user.email.toLowerCase(),
      status: 'accepted',
    })
      .populate('exam', 'title subject difficulty questions proctored timePerQuestion showFlashcards showReview allowReattempt certificateEnabled passingPercentage topics expiryDate')
      .populate('invitedBy', 'name')
      .populate('group', 'name')
      .sort({ updatedAt: -1 });
    res.json({ invites });
  } catch (err) { next(err); }
};

// POST /api/instructor/invite/:token/reject
export const rejectInvite = async (req, res, next) => {
  try {
    const invite = await ExamInvite.findOne({ token: req.params.token });
    if (!invite) return next(new AppError('Invalid invite link', 404));
    if (invite.email.toLowerCase() !== req.user.email.toLowerCase()) {
      return next(new AppError('This invite was sent to a different email address', 403));
    }
    if (invite.status !== 'pending') {
      return res.json({ message: `Invite already ${invite.status}` });
    }
    invite.status = 'expired';
    await invite.save();
    res.json({ message: 'Invite declined' });
  } catch (err) { next(err); }
};

// GET /api/instructor/exams/:examId/report
export const getExamReport = async (req, res, next) => {
  try {
    const exam = await Exam.findById(req.params.examId).select('title subject difficulty proctored questions createdBy passingPercentage screenshotEnabled');
    if (!exam) return next(new AppError('Exam not found', 404));
    if (exam.createdBy.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return next(new AppError('Not authorized', 403));
    }

    const invites = await ExamInvite.find({ exam: exam._id })
      .populate({ path: 'result', select: 'score totalQuestions correctCount incorrectCount percentage passed timeTaken proctored violations topicAccuracy createdAt' })
      .sort({ createdAt: -1 });

    const emailSet = [...new Set(invites.map(inv => inv.email))];
    const allResults = await Result.find({
      exam: exam._id,
      user: { $in: await User.find({ email: { $in: emailSet } }).distinct('_id') },
    }).sort({ createdAt: 1 });

    const users = await User.find({ email: { $in: emailSet } }).select('email name');
    const resultsByUser = {};
    allResults.forEach(r => {
      const uid = r.user.toString();
      if (!resultsByUser[uid]) resultsByUser[uid] = [];
      resultsByUser[uid].push(r);
    });

    // Screenshot counts per user
    const screenshotCounts = exam.screenshotEnabled
      ? await Screenshot.aggregate([
          { $match: { exam: exam._id } },
          { $group: { _id: '$user', count: { $sum: 1 } } }
        ])
      : [];
    const screenshotMap = Object.fromEntries(screenshotCounts.map(s => [s._id.toString(), s.count]));

    const rows = invites.map(inv => {
      const userInfo = users.find(u => u.email === inv.email);
      const uid = userInfo?._id?.toString();
      const userResults = uid ? (resultsByUser[uid] || []) : [];
      const latestResult = userResults[userResults.length - 1] || null;
      const bestResult = userResults.reduce((best, r) => (!best || r.percentage > best.percentage ? r : best), null);

      return {
        _id: inv._id,
        email: inv.email,
        name: userInfo?.name || null,
        inviteStatus: inv.status,
        invitedAt: inv.createdAt,
        reattemptCount: inv.reattemptCount || 0,
        totalAttempts: userResults.length,
        screenshotCount: uid ? (screenshotMap[uid] || 0) : 0,
        latestResult: latestResult ? {
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
        } : null,
        bestResult: bestResult ? {
          percentage: bestResult.percentage,
          passed: bestResult.passed,
          attemptedAt: bestResult.createdAt,
        } : null,
        allAttempts: userResults.map(r => ({
          resultId: r._id,
          percentage: r.percentage,
          passed: r.passed,
          timeTaken: r.timeTaken,
          violations: r.violations,
          proctored: r.proctored,
          attemptedAt: r.createdAt,
        })),
      };
    });

    const attempted = rows.filter(r => r.totalAttempts > 0);
    const summary = {
      totalInvites: invites.length,
      accepted: invites.filter(i => i.status === 'accepted').length,
      pending: invites.filter(i => i.status === 'pending').length,
      attempted: attempted.length,
      passed: rows.filter(r => r.latestResult?.passed).length,
      avgScore: attempted.length
        ? Math.round(attempted.filter(r => r.latestResult).reduce((s, r) => s + r.latestResult.percentage, 0) / attempted.filter(r => r.latestResult).length || 0)
        : 0,
    };

    res.json({ exam, rows, summary });
  } catch (err) { next(err); }
};
