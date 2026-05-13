import crypto from 'crypto';
import { AppError } from '../middleware/errorHandler.js';
import Exam from '../models/Exam.js';
import ExamInvite from '../models/ExamInvite.js';
import Group from '../models/Group.js';
import Result from '../models/Result.js';
import Screenshot from '../models/Screenshot.js';
import SchoolClass from '../models/SchoolClass.js';
import SchoolClassEnrollment from '../models/SchoolClassEnrollment.js';
import User from '../models/User.js';
import UserExamShuffle from '../models/UserExamShuffle.js';
import Enterprise from '../models/Enterprise.js';
import { PROCTORING_SCREENSHOT_RETENTION_DAYS } from '../services/proctoringScreenshotRetention.js';
import { buildInstructorExamReportData } from '../utils/instructorExamReportData.js';
import { buildDisplayQuestions, getBaseQuestionsForExam } from '../utils/examShuffleRuntime.js';
import { getSettings } from '../models/SystemSettings.js';
import { addMonthsClamped } from '../services/subscriptionLifecycleService.js';
import { sendInstructorInviteEmail } from '../services/emailService.js';
import { delCache, getCache, setCache } from '../services/cacheService.js';
import { fromReq, log } from '../utils/activityLogger.js';
import logger from '../utils/logger.js';
import { computeResultMetrics } from '../utils/resultMetrics.js';
import { createNotificationsForUsers } from './notificationController.js';

/** Ensures answers are always a plain array for JSON / frontend iteration. */
function normalizeAnswersArray(ans) {
  if (!ans) return [];
  if (Array.isArray(ans)) return ans;
  if (typeof ans === 'object') {
    const keys = Object.keys(ans);
    const numeric = keys.filter(k => /^\d+$/.test(k));
    if (numeric.length) {
      return numeric.sort((a, b) => Number(a) - Number(b)).map(k => ans[k]).filter(Boolean);
    }
    return Object.values(ans).filter(v => v != null && typeof v === 'object');
  }
  return [];
}

function topicAccuracyToPlain(ta) {
  if (ta == null) return {};
  if (ta instanceof Map) return Object.fromEntries(ta);
  if (typeof ta === 'object' && !Array.isArray(ta)) return { ...ta };
  return {};
}

const xpFromPercentage = (percentage, difficulty) => {
  const base = { easy: 10, medium: 20, hard: 35 };
  return Math.round((base[difficulty] || 10) * (percentage / 100));
};

const isEnterpriseSchoolInstructor = async (user) => {
  if (user?.role !== 'instructor' || !user?.enterpriseId) return false;
  const ent = await Enterprise.findById(user.enterpriseId).select('mode').lean();
  return ent?.mode === 'school';
};

// POST /api/instructor/become
export const becomeInstructor = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    if (user.role === 'instructor') return res.json({ message: 'Already an instructor', role: 'instructor' });
    if (user.role === 'admin') return next(new AppError('Admins cannot change role', 400));

    const now = new Date();
    const trialActive = user.instructorTrialEndsAt && user.instructorTrialEndsAt > now;

    if (user.getEffectivePlan() === 'free' && !trialActive) {
      if (user.enterpriseId) {
        return next(new AppError('Your organization controls licensing. Contact your principal or administrator.', 403));
      }
      if (user.instructorTrialUsed) {
        return next(new AppError('Active premium plan required to become an instructor.', 403));
      }
      const trialEnd = addMonthsClamped(now, 1);
      user.instructorTrialUsed = true;
      user.instructorTrialEndsAt = trialEnd;
      user.plan = 'pro';
      user.planExpiresAt = trialEnd;
      user.examsCreatedThisMonth = 0;
      user.monthlyExamResetDate = now;
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
    const key = `instructor_exams:${req.user._id}`;
    const cached = await getCache(key);
    if (cached) return res.json(cached);

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

    const payload = { exams: examsWithStats };
    await setCache(key, payload, 300);
    res.json(payload);
  } catch (err) { next(err); }
};

// POST /api/instructor/exams/:examId/invite
export const sendInvite = async (req, res, next) => {
  try {
    if (await isEnterpriseSchoolInstructor(req.user)) {
      return next(new AppError('For enterprise school teachers, invite by class only.', 403));
    }
    const { email } = req.body;
    if (!email) return next(new AppError('Email is required', 400));

    const exam = await Exam.findOne({ _id: req.params.examId, createdBy: req.user._id });
    if (!exam) return next(new AppError('Exam not found or unauthorized', 404));

    const existing = await ExamInvite.findOne({ exam: exam._id, email, status: { $ne: 'expired' } });
    if (existing) return next(new AppError('This email has already been invited', 409));

    const numVariants = exam.multipleSets && Array.isArray(exam.questionVariants) && exam.questionVariants.length > 0
      ? exam.questionVariants.length
      : 1;
    const assignedVariantIndex = numVariants > 1 ? crypto.randomInt(0, numVariants) : 0;
    const invite = await ExamInvite.create({
      exam: exam._id,
      invitedBy: req.user._id,
      email,
      assignedVariantIndex,
    });
    const clientBase = process.env.CLIENT_URL || 'http://localhost:5173';
    const inviteUrl = `${clientBase}/exam/${exam._id}?invite=${invite.token}`;
    const signupUrl = `${clientBase}/signup?invite=${invite.token}&email=${encodeURIComponent(email)}`;

    const settings = await getSettings();
    if (settings.emailInstructorInviteEnabled) {
      sendInstructorInviteEmail({
        email,
        instructorName: req.user.name,
        examTitle: exam.title,
        examSubject: exam.subject,
        inviteUrl,
        signupUrl,
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
      .populate('classId', 'name section')
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
    if (req.user.enterpriseId) {
      const ent = await Enterprise.findById(req.user.enterpriseId).select('aiProctoringEnabled').lean();
      if (ent && ent.aiProctoringEnabled === false) {
        return next(new AppError('AI Proctoring is disabled in your enterprise plan.', 403));
      }
    }

    const screenshots = await Screenshot.find({ exam: exam._id })
      .populate('user', 'name email')
      .populate('result', 'percentage passed violations')
      .sort({ capturedAt: -1 })
      .limit(100);

    res.json({ screenshots, exam, screenshotRetentionDays: PROCTORING_SCREENSHOT_RETENTION_DAYS });
  } catch (err) { next(err); }
};

// GET /api/instructor/analytics
export const getInstructorAnalytics = async (req, res, next) => {
  try {
    const key = `analytics:${req.user._id}`;
    const cached = await getCache(key);
    if (cached) return res.json(cached);

    const exams = await Exam.find({ createdBy: req.user._id }).sort({ createdAt: -1 });
    const examIds = exams.map(e => e._id);

    const [inviteStats, inviteByExam, uniqueUserStats] = await Promise.all([
      ExamInvite.aggregate([
        { $match: { exam: { $in: examIds } } },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]),
      ExamInvite.aggregate([
        { $match: { exam: { $in: examIds } } },
        {
          $group: {
            _id: '$exam',
            notAttempted: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ['$status', 'accepted'] },
                      { $eq: [{ $ifNull: ['$result', null] }, null] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]),
      // One row per (exam, user): latest attempt only — summary counts unique learners, not every Result doc
      Result.aggregate([
        { $match: { exam: { $in: examIds } } },
        { $sort: { createdAt: -1 } },
        {
          $group: {
            _id: { exam: '$exam', user: '$user' },
            latestPassed: { $first: '$passed' },
            latestPct: { $first: '$percentage' },
          },
        },
        {
          $group: {
            _id: '$_id.exam',
            uniqueAttempted: { $sum: 1 },
            uniquePassed: { $sum: { $cond: ['$latestPassed', 1, 0] } },
            avgLatestScore: { $avg: '$latestPct' },
          },
        },
      ]),
    ]);

    const inviteStatusMap = Object.fromEntries(inviteStats.map(i => [i._id, i.count]));
    const inviteExamMap = Object.fromEntries(inviteByExam.map(i => [i._id.toString(), i]));
    const resultMap = Object.fromEntries(uniqueUserStats.map(r => {
      const ua = r.uniqueAttempted || 0;
      const up = r.uniquePassed || 0;
      return [r._id.toString(), {
        count: ua,
        avgScore: r.avgLatestScore,
        passCount: up,
        failCount: Math.max(0, ua - up),
      }];
    }));

    const totalInvites = (inviteStatusMap.pending || 0) + (inviteStatusMap.accepted || 0) + (inviteStatusMap.expired || 0);
    const acceptedInvites = inviteStatusMap.accepted || 0;
    const totalAttempts = uniqueUserStats.reduce((a, r) => a + (r.uniqueAttempted || 0), 0);
    const examsWithAttempts = uniqueUserStats.filter(r => (r.uniqueAttempted || 0) > 0);
    const avgScore = examsWithAttempts.length
      ? Math.round(examsWithAttempts.reduce((s, r) => s + (r.avgLatestScore || 0), 0) / examsWithAttempts.length)
      : 0;

    const examsWithStats = exams.map(e => {
      const inv = inviteExamMap[e._id.toString()] || {};
      const st = resultMap[e._id.toString()] || { count: 0, avgScore: 0, passCount: 0, failCount: 0 };
      return {
        _id: e._id, title: e.title, subject: e.subject,
        difficulty: e.difficulty, timesAttempted: e.timesAttempted,
        proctored: e.proctored, certificate: e.certificate,
        allowReattempt: e.allowReattempt, showAnswersAfter: e.showAnswersAfter,
        passingPercentage: e.passingPercentage, expiryDate: e.expiryDate,
        questions: e.questions, questionCount: e.questions?.length || 0,
        stats: {
          count: st.count,
          avgScore: st.avgScore,
          passCount: st.passCount || 0,
          failCount: st.failCount ?? 0,
          notAttempted: inv.notAttempted || 0,
        },
      };
    });

    const payload = { totalExams: exams.length, totalInvites, acceptedInvites, totalAttempts, avgScore, exams: examsWithStats };
    await setCache(key, payload, 600);
    res.json(payload);
  } catch (err) { next(err); }
};

// GET /api/instructor/analytics/detailed
export const getDetailedAnalytics = async (req, res, next) => {
  try {
    const key = `analytics_detailed:${req.user._id}`;
    const cached = await getCache(key);
    if (cached) return res.json(cached);

    const exams = await Exam.find({ createdBy: req.user._id }).sort({ createdAt: -1 }).lean();
    const examIds = exams.map(e => e._id);

    // All results for instructor's exams with user info
    const results = await Result.find({ exam: { $in: examIds } })
      .populate('user', 'name email schoolClassId')
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
          user:     { _id: r.user._id, name: r.user.name, email: r.user.email, schoolClassId: r.user.schoolClassId || null },
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

    // Class-wise performance for enterprise school instructors
    let classPerformance = [];
    if (req.user.enterpriseId) {
      const ent = await Enterprise.findById(req.user.enterpriseId).select('mode').lean();
      if (ent?.mode === 'school') {
        const classes = await SchoolClass.find({ enterprise: req.user.enterpriseId }).lean();
        const enrollRows = await SchoolClassEnrollment.find({
          enterprise: req.user.enterpriseId,
          schoolClass: { $in: classes.map((cl) => cl._id) },
        }).select('schoolClass user').lean();
        const classIdToUserIds = new Map();
        for (const row of enrollRows) {
          const cid = row.schoolClass.toString();
          if (!classIdToUserIds.has(cid)) classIdToUserIds.set(cid, new Set());
          classIdToUserIds.get(cid).add(row.user.toString());
        }
        const legacyClassUsers = await User.find({
          enterpriseId: req.user.enterpriseId,
          role: 'user',
          schoolClassId: { $in: classes.map((cl) => cl._id) },
        }).select('_id schoolClassId').lean();
        for (const u of legacyClassUsers) {
          const cid = u.schoolClassId?.toString();
          if (!cid) continue;
          if (!classIdToUserIds.has(cid)) classIdToUserIds.set(cid, new Set());
          classIdToUserIds.get(cid).add(u._id.toString());
        }

        classPerformance = classes.map((c) => {
          const uidSet = classIdToUserIds.get(c._id.toString()) || new Set();
          const classStudents = studentPerformance.filter((s) => uidSet.has(s.user._id.toString()));
          const totalAttemptsByClass = classStudents.reduce((a, s) => a + (s.attempts || 0), 0);
          const avgScoreByClass = classStudents.length
            ? Math.round(classStudents.reduce((a, s) => a + (s.avgScore || 0), 0) / classStudents.length)
            : 0;
          const passRateByClass = classStudents.length
            ? Math.round(classStudents.reduce((a, s) => a + (s.passRate || 0), 0) / classStudents.length)
            : 0;
          return {
            _id: c._id,
            name: c.name,
            section: c.section || '',
            studentCount: classStudents.length,
            totalAttempts: totalAttemptsByClass,
            avgScore: avgScoreByClass,
            passRate: passRateByClass,
            students: classStudents,
          };
        });
      }
    }

    const payload = {
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
      classPerformance,
    };
    await setCache(key, payload, 600);
    res.json(payload);
  } catch (err) { next(err); }
};

export const sendGroupInvite = async (req, res, next) => {
  try {
    if (await isEnterpriseSchoolInstructor(req.user)) {
      return next(new AppError('For enterprise school teachers, invite by class only.', 403));
    }
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
    const clientBase = process.env.CLIENT_URL || 'http://localhost:5173';
    const inviteUrlBase = `${clientBase}/exam/${exam._id}`;
    const numVariants = exam.multipleSets && Array.isArray(exam.questionVariants) && exam.questionVariants.length > 0
      ? exam.questionVariants.length
      : 1;

    let sent = 0, skipped = 0;
    for (const email of emails) {
      const existing = await ExamInvite.findOne({ exam: exam._id, email, status: { $ne: 'expired' } });
      if (existing) { skipped++; continue; }
      const assignedVariantIndex = numVariants > 1 ? crypto.randomInt(0, numVariants) : 0;
      const invite = await ExamInvite.create({
        exam: exam._id,
        invitedBy: req.user._id,
        email,
        group: groupId,
        assignedVariantIndex,
      });
      sent++;
      if (settings.emailInstructorInviteEnabled) {
        const perInviteUrl = `${inviteUrlBase}?invite=${invite.token}`;
        const signupUrl = `${clientBase}/signup?invite=${invite.token}&email=${encodeURIComponent(email)}`;
        sendInstructorInviteEmail({
          email,
          instructorName: req.user.name,
          examTitle: exam.title,
          examSubject: exam.subject,
          inviteUrl: perInviteUrl,
          signupUrl,
          expiresAt: invite.expiresAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }),
        }).catch(logger.error);
      }
    }

    res.json({ message: `Invites sent to ${sent} member${sent !== 1 ? 's' : ''}. ${skipped} already invited.`, sent, skipped });
  } catch (err) { next(err); }
};

export const sendClassInvite = async (req, res, next) => {
  try {
    if (!(await isEnterpriseSchoolInstructor(req.user))) {
      return next(new AppError('Class invite is available for enterprise school teachers only.', 403));
    }

    const classIds = Array.isArray(req.body.classIds)
      ? req.body.classIds.filter(Boolean)
      : (req.body.classId ? [req.body.classId] : []);
    if (!classIds.length) return next(new AppError('At least one class is required', 400));

    const exam = await Exam.findOne({ _id: req.params.examId, createdBy: req.user._id });
    if (!exam) return next(new AppError('Exam not found or unauthorized', 404));

    const classes = await SchoolClass.find({
      _id: { $in: classIds },
      enterprise: req.user.enterpriseId,
    }).select('name section').lean();
    if (!classes.length) return next(new AppError('Class not found', 404));
    const classIdSet = new Set(classes.map((c) => c._id.toString()));
    const validClassIds = classIds.filter((id) => classIdSet.has(id.toString()));
    if (!validClassIds.length) return next(new AppError('Class not found', 404));

    const enrolledRows = await SchoolClassEnrollment.find({
      schoolClass: { $in: validClassIds },
    })
      .populate('user', 'email name schoolClassId')
      .lean();

    const fromEnrollment = enrolledRows
      .filter((r) => r.user)
      .map((r) => ({
        ...r.user,
        _inviteClassId: r.schoolClass,
      }));

    const enrolledEmails = new Set(fromEnrollment.map((u) => u.email?.toLowerCase()).filter(Boolean));

    const legacyStudents = await User.find({
      enterpriseId: req.user.enterpriseId,
      role: 'user',
      schoolClassId: { $in: validClassIds },
    })
      .select('email name schoolClassId')
      .lean();

    const students = [...fromEnrollment];
    for (const u of legacyStudents) {
      const em = u.email?.toLowerCase();
      if (em && !enrolledEmails.has(em)) {
        students.push({ ...u, _inviteClassId: u.schoolClassId });
        enrolledEmails.add(em);
      }
    }

    if (!students.length) {
      return next(new AppError('No students found in this class', 400));
    }

    const settings = await getSettings();
    const clientBase = process.env.CLIENT_URL || 'http://localhost:5173';
    const inviteUrlBase = `${clientBase}/exam/${exam._id}`;
    const numVariants = exam.multipleSets && Array.isArray(exam.questionVariants) && exam.questionVariants.length > 0
      ? exam.questionVariants.length
      : 1;

    let sent = 0; let skipped = 0;
    for (const st of students) {
      const email = st.email?.toLowerCase();
      if (!email) continue;
      const existing = await ExamInvite.findOne({ exam: exam._id, email, status: { $ne: 'expired' } });
      if (existing) { skipped++; continue; }
      const assignedVariantIndex = numVariants > 1 ? crypto.randomInt(0, numVariants) : 0;
      const invite = await ExamInvite.create({
        exam: exam._id,
        invitedBy: req.user._id,
        email,
        classId: validClassIds.find((cid) => cid.toString() === (st._inviteClassId || st.schoolClassId)?.toString()) || null,
        assignedVariantIndex,
      });
      sent++;
      if (settings.emailInstructorInviteEnabled) {
        const perInviteUrl = `${inviteUrlBase}?invite=${invite.token}`;
        const signupUrl = `${clientBase}/signup?invite=${invite.token}&email=${encodeURIComponent(email)}`;
        sendInstructorInviteEmail({
          email,
          instructorName: req.user.name,
          examTitle: exam.title,
          examSubject: exam.subject,
          inviteUrl: perInviteUrl,
          signupUrl,
          expiresAt: invite.expiresAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }),
        }).catch(logger.error);
      }
    }

    res.json({
      message: `Invites sent to ${sent} student${sent !== 1 ? 's' : ''} across ${classes.length} class${classes.length !== 1 ? 'es' : ''}. ${skipped} already invited.`,
      sent,
      skipped,
    });
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

    const title = invite.exam?.title || 'your test';
    createNotificationsForUsers([req.user._id], {
      type: 'exam_invite',
      title: 'Test ready to take',
      message: `You're enrolled for "${title}". Start it from My Tests when you're ready.`,
      link: '/tests',
      severity: 'info',
      meta: { examId: invite.exam?._id?.toString(), inviteToken: invite.token },
    }).catch(logger.error);

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

    const { rows, summary } = await buildInstructorExamReportData(exam);
    res.json({ exam, rows, summary });
  } catch (err) { next(err); }
};

// GET /api/instructor/exams/:examId/students/:userId/report
export const getStudentExamReport = async (req, res, next) => {
  try {
    const { examId, userId } = req.params;
    const exam = await Exam.findById(examId).select(
      'title subject difficulty proctored questions questionVariants multipleSets createdBy passingPercentage screenshotEnabled timePerQuestion',
    );
    if (!exam) return next(new AppError('Exam not found', 404));
    if (exam.createdBy.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return next(new AppError('Not authorized', 403));
    }
    if (req.user.enterpriseId && exam.proctored) {
      const ent = await Enterprise.findById(req.user.enterpriseId).select('aiProctoringEnabled').lean();
      if (ent && ent.aiProctoringEnabled === false) {
        return next(new AppError('AI Proctoring is disabled in your enterprise plan.', 403));
      }
    }

    const student = await User.findById(userId).select('name email plan role');
    if (!student) return next(new AppError('Student not found', 404));

    const results = await Result.find({ exam: exam._id, user: student._id }).sort({ createdAt: -1 }).lean();
    const latest = results[0] || null;

    const shuffle = await UserExamShuffle.findOne({ user: student._id, exam: exam._id }).lean();
    const variantIdx = shuffle?.variantIndex ?? 0;
    const baseQs = getBaseQuestionsForExam(exam, variantIdx);
    const questionsForReport = shuffle ? buildDisplayQuestions(baseQs, shuffle) : baseQs;

    const screenshots = exam.screenshotEnabled
      ? await Screenshot.find({ exam: exam._id, user: student._id })
          .populate('result', 'percentage passed violations createdAt')
          .sort({ capturedAt: -1 })
          .limit(200)
          .lean()
      : [];

    const topicAccuracy = topicAccuracyToPlain(latest?.topicAccuracy);
    const weakTopics = Object.entries(topicAccuracy)
      .filter(([, v]) => typeof v === 'number' && v < 60)
      .sort((a, b) => a[1] - b[1])
      .slice(0, 5)
      .map(([k]) => k);

    const answers = normalizeAnswersArray(latest?.answers);
    const questionCount = questionsForReport.length || exam.questions?.length || 0;
    const avgAITotal = answers.filter(a => typeof a.aiScore === 'number');
    const avgAIScore = avgAITotal.length
      ? Math.round(avgAITotal.reduce((s, a) => s + (a.aiScore || 0), 0) / avgAITotal.length)
      : null;

    const recommendation = {
      summary: latest
        ? (weakTopics.length
          ? `Focus on: ${weakTopics.join(', ')}. Review explanations and retake after targeted practice.`
          : 'Solid performance. Increase difficulty or reduce time-per-question to challenge further.')
        : 'No attempts yet. Once the student attempts, you will see topic-wise insights and recommendations.',
      weakTopics,
      tips: [
        ...(weakTopics.length ? ['Revise weak topics and retry under timed conditions.', 'Practice 10–20 targeted questions per weak topic.'] : ['Try a harder exam or add more topics to broaden coverage.']),
        ...(latest?.proctored && latest?.violations > 0 ? ['Violations detected — consider reviewing screenshots for integrity concerns.'] : []),
        ...(avgAIScore !== null ? [`AI-evaluated questions average: ${avgAIScore}/100.`] : []),
      ],
    };

    const examOut = {
      ...exam.toObject(),
      questions: questionsForReport,
    };

    res.json({
      exam: examOut,
      student,
      screenshotRetentionDays: PROCTORING_SCREENSHOT_RETENTION_DAYS,
      attempts: results.map(r => ({
        _id: r._id,
        percentage: r.percentage,
        passed: r.passed,
        score: r.score,
        correctCount: r.correctCount,
        incorrectCount: r.incorrectCount,
        unattemptedCount: r.unattemptedCount,
        timeTaken: r.timeTaken,
        proctored: r.proctored,
        violations: r.violations,
        proctoringEvents: Array.isArray(r.proctoringEvents) ? r.proctoringEvents : [],
        topicAccuracy: topicAccuracyToPlain(r.topicAccuracy),
        createdAt: r.createdAt,
      })),
      latestResult: latest ? {
        ...latest,
        answers: normalizeAnswersArray(latest.answers),
        topicAccuracy: topicAccuracyToPlain(latest.topicAccuracy),
        totalQuestions: latest.totalQuestions || questionCount,
        proctoringEvents: Array.isArray(latest.proctoringEvents) ? latest.proctoringEvents : [],
      } : null,
      screenshots,
      insights: {
        weakTopics,
        avgAIScore,
      },
      recommendation,
    });
  } catch (err) { next(err); }
};

// PATCH /api/instructor/results/:resultId/reevaluate
export const reevaluateResult = async (req, res, next) => {
  try {
    const { resultId } = req.params;
    const { overrides } = req.body;
    if (!Array.isArray(overrides) || overrides.length === 0) {
      return next(new AppError('overrides must be a non-empty array', 400));
    }

    const result = await Result.findById(resultId);
    if (!result) return next(new AppError('Result not found', 404));

    const exam = await Exam.findById(result.exam);
    if (!exam) return next(new AppError('Exam not found', 404));
    if (exam.createdBy.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return next(new AppError('Not authorized', 403));
    }

    if (!Array.isArray(result.answers)) {
      result.answers = normalizeAnswersArray(result.answers);
      result.markModified('answers');
    }

    const shuffle = await UserExamShuffle.findOne({ user: result.user, exam: exam._id }).lean();
    const baseQs = getBaseQuestionsForExam(exam, shuffle?.variantIndex ?? 0);
    const questionsForScoring = shuffle ? buildDisplayQuestions(baseQs, shuffle) : (exam.questions || []);
    const examForMetrics = { ...exam.toObject(), questions: questionsForScoring };

    for (const o of overrides) {
      if (o.questionIndex === undefined || o.questionIndex === null) continue;
      const sub = result.answers.find(a => a.questionIndex === Number(o.questionIndex));
      if (!sub) continue;
      if (typeof o.isCorrect === 'boolean') sub.isCorrect = o.isCorrect;
      if (typeof o.aiScore === 'number') sub.aiScore = Math.max(0, Math.min(100, Math.round(o.aiScore)));
      if (typeof o.aiFeedback === 'string') sub.aiFeedback = o.aiFeedback.slice(0, 4000);
    }

    result.markModified('answers');
    const answerPlain = result.answers.map(a => (typeof a.toObject === 'function' ? a.toObject() : a));
    const m = computeResultMetrics(examForMetrics, answerPlain);
    result.correctCount = m.correctCount;
    result.incorrectCount = m.incorrectCount;
    result.unattemptedCount = m.unattemptedCount;
    result.percentage = m.percentage;
    result.passed = m.passed;
    result.score = m.score;
    result.totalQuestions = m.totalQuestions;
    result.topicAccuracy = m.topicAccuracy;
    result.xpEarned = xpFromPercentage(m.percentage, exam.difficulty);

    await result.save();

    await delCache(
      `analytics_detailed:${req.user._id}`,
      `analytics:${req.user._id}`,
      `instructor_exams:${req.user._id}`,
      `exams:${exam.createdBy}`,
    );

    res.json({
      message: 'Result updated',
      result: {
        _id: result._id,
        percentage: result.percentage,
        passed: result.passed,
        correctCount: result.correctCount,
        incorrectCount: result.incorrectCount,
        unattemptedCount: result.unattemptedCount,
        score: result.score,
      },
    });
  } catch (err) { next(err); }
};
