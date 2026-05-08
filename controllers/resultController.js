import { AppError } from '../middleware/errorHandler.js';
import Certificate from '../models/Certificate.js';
import Exam from '../models/Exam.js';
import ExamInvite from '../models/ExamInvite.js';
import Result from '../models/Result.js';
import UserExamShuffle from '../models/UserExamShuffle.js';
import { buildDisplayQuestions, getBaseQuestionsForExam } from '../utils/examShuffleRuntime.js';
import Screenshot from '../models/Screenshot.js';
import User from '../models/User.js';
import { getSettings } from '../models/SystemSettings.js';
import { sendResultEmail, sendProctoringViolationEmail } from '../services/emailService.js';
import { generateCertificatePDF } from '../services/pdfService.js';
import { evaluateCodingAnswer, evaluateDescriptiveAnswer } from '../services/aiService.js';
import { createNotificationsForUsers } from './notificationController.js';
import { log, fromReq } from '../utils/activityLogger.js';
import logger from '../utils/logger.js';
import { delCache, getCache, setCache } from '../services/cacheService.js';

const calcXP = (percentage, difficulty) => {
  const base = { easy: 10, medium: 20, hard: 35 };
  return Math.round((base[difficulty] || 10) * (percentage / 100));
};

const detectWeakTopics = (answers, questions) => {
  const topicMap = {};
  answers.forEach(a => {
    const q = questions[a.questionIndex];
    if (!q) return;
    const t = q.topic || 'General';
    if (!topicMap[t]) topicMap[t] = { correct: 0, total: 0 };
    topicMap[t].total++;
    if (a.isCorrect) topicMap[t].correct++;
  });
  return Object.entries(topicMap)
    .filter(([, v]) => v.total > 0 && v.correct / v.total < 0.5)
    .map(([k]) => k);
};

export const submitResult = async (req, res, next) => {
  try {
    const { examId, answers, timeTaken, violations, proctoringEvents = [] } = req.body;
    if (!examId) return next(new AppError('examId is required', 400));
    if (!Array.isArray(answers) || answers.length === 0) return next(new AppError('answers array is required', 400));

    const settings = await getSettings();
    const exam = await Exam.findById(examId);
    if (!exam) return next(new AppError('Exam not found', 404));

    const shuffle = await UserExamShuffle.findOne({ user: req.user._id, exam: exam._id });
    const baseQs = getBaseQuestionsForExam(exam, shuffle?.variantIndex ?? 0);
    const questionsForScoring = shuffle
      ? buildDisplayQuestions(baseQs, shuffle)
      : exam.questions;

    // Check expiry (skip for owner and admin)
    const isOwner = exam.createdBy.toString() === req.user._id.toString();
    if (!isOwner && req.user.role !== 'admin' && exam.expiryDate && new Date(exam.expiryDate) < new Date()) {
      return next(new AppError('This test has expired', 403));
    }

    const autoTerminated = false;
    const sanitizedEvents = Array.isArray(proctoringEvents)
      ? proctoringEvents
          .filter(e => e && typeof e.message === 'string')
          .slice(-500)
          .map(e => ({
            type: String(e.type || 'violation').slice(0, 64),
            severity: ['info', 'warning', 'critical'].includes(e.severity) ? e.severity : 'warning',
            message: String(e.message).slice(0, 500),
            source: String(e.source || 'client').slice(0, 64),
            timestamp: e.timestamp ? new Date(e.timestamp) : new Date(),
          }))
      : [];

    const passThreshold = exam.passingPercentage ?? 75;
    const hasCodingQuestions = questionsForScoring.some(q => q.type === 'coding');
    const hasDescriptiveQuestions = questionsForScoring.some(q => q.type === 'descriptive');

    // Score MCQ answers immediately; collect coding/descriptive answers for AI eval
    let correctCount = 0;
    let unattemptedCount = 0;
    const topicMap = {};
    const pendingCodingEvals = [];
    const pendingDescriptiveEvals = [];

    const scoredAnswers = answers.map(a => {
      const q = questionsForScoring[a.questionIndex];
      if (!q) return { ...a, isCorrect: false };

      const t = q.topic || 'General';
      if (!topicMap[t]) topicMap[t] = { correct: 0, total: 0 };
      topicMap[t].total++;

      if (q.type === 'coding') {
        pendingCodingEvals.push({ index: a.questionIndex, code: a.code || '', q });
        return { ...a, isCorrect: false, aiScore: null, aiFeedback: '' };
      }

      if (q.type === 'descriptive') {
        pendingDescriptiveEvals.push({ index: a.questionIndex, text: a.textAnswer || '', q });
        return { ...a, isCorrect: false, aiScore: null, aiFeedback: '' };
      }

      // MCQ scoring
      const noAnswer = a.selectedOption === null || a.selectedOption === undefined;
      const isCorrect = !noAnswer && a.selectedOption === q.correctAnswer;
      if (noAnswer) unattemptedCount++;
      else if (isCorrect) { correctCount++; topicMap[t].correct++; }
      return { ...a, isCorrect };
    });

    // Evaluate coding answers in parallel
    if (pendingCodingEvals.length > 0) {
      const evalResults = await Promise.all(
        pendingCodingEvals.map(({ code, q }) =>
          evaluateCodingAnswer({
            question: q.question,
            code,
            language: q.language || 'javascript',
            sampleSolution: q.sampleSolution || '',
            difficulty: exam.difficulty,
          })
        )
      );

      evalResults.forEach((evalResult, i) => {
        const { index } = pendingCodingEvals[i];
        const scored = scoredAnswers.find(a => a.questionIndex === index);
        const q = questionsForScoring[index];
        const t = q.topic || 'General';

        if (scored) {
          scored.isCorrect = evalResult.isCorrect;
          scored.aiScore   = evalResult.score;
          scored.aiFeedback = evalResult.feedback;
        }
        if (evalResult.isCorrect) {
          correctCount++;
          if (topicMap[t]) topicMap[t].correct++;
        }
      });
    }

    // Evaluate descriptive answers in parallel
    if (pendingDescriptiveEvals.length > 0) {
      const evalResults = await Promise.all(
        pendingDescriptiveEvals.map(({ text, q }) =>
          evaluateDescriptiveAnswer({
            question: q.question,
            answer: text,
            modelAnswer: q.modelAnswer || '',
            keyPoints: q.keyPoints || [],
            difficulty: exam.difficulty,
          })
        )
      );

      evalResults.forEach((evalResult, i) => {
        const { index } = pendingDescriptiveEvals[i];
        const scored = scoredAnswers.find(a => a.questionIndex === index);
        const q = questionsForScoring[index];
        const t = q.topic || 'General';

        if (scored) {
          scored.isCorrect = evalResult.isCorrect;
          scored.aiScore   = evalResult.score;
          scored.aiFeedback = evalResult.feedback;
        }
        if (evalResult.isCorrect) {
          correctCount++;
          if (topicMap[t]) topicMap[t].correct++;
        }
      });
    }

    const total = questionsForScoring.length;
    const incorrectCount = total - correctCount - unattemptedCount;
    const percentage = Math.round((correctCount / total) * 100);
    const passed = percentage >= passThreshold;
    const xpEarned = calcXP(percentage, exam.difficulty);
    const topicAccuracy = {};
    for (const [t, v] of Object.entries(topicMap)) {
      topicAccuracy[t] = Math.round((v.correct / v.total) * 100);
    }

    // Instructor invite lookup (reattempt tracking)
    let inviteRecord = null;
    let instructorName = null;
    let instructorId = null;
    {
      const invite = await ExamInvite.findOne({ exam: exam._id, email: req.user.email, status: 'accepted' }).populate('invitedBy', 'name');
      if (invite) {
        inviteRecord = invite;
        if (invite.invitedBy) {
          instructorName = invite.invitedBy.name;
          instructorId = invite.invitedBy._id;
        }
        if (invite.result) {
          invite.reattemptCount = (invite.reattemptCount || 0) + 1;
          await invite.save();
        }
      }
    }

    // Link pending screenshots to this result session (best-effort)
    const pendingScreenshots = await Screenshot.find({
      exam: exam._id,
      user: req.user._id,
      result: null,
    }).sort({ capturedAt: -1 }).limit(10);

    // Certificate
    let certificate = null;
    let pdfBuffer = null;
    if (passed && settings.certificatesEnabled && exam.certificateEnabled !== false) {
      certificate = await Certificate.create({
        user: req.user._id, exam: exam._id, result: null,
        userName: req.user.name, examName: exam.title,
        score: correctCount, percentage, proctored: exam.proctored,
        instructorName, instructorId,
      });
      try {
        pdfBuffer = await generateCertificatePDF({
          userName: req.user.name, examName: exam.title,
          score: `${correctCount}/${total}`, percentage,
          certId: certificate.certId, issuedAt: certificate.issuedAt,
          proctored: exam.proctored, instructorName,
          certSettings: settings,
          totalQuestions: total,
          timeTaken: timeTaken || null,
          difficulty: exam.difficulty,
        });
      } catch (pdfErr) { logger.error('PDF generation failed:', pdfErr.message); }
    }

    const result = await Result.create({
      user: req.user._id, exam: exam._id, answers: scoredAnswers,
      score: correctCount, totalQuestions: total, correctCount,
      incorrectCount, unattemptedCount, percentage, timeTaken,
      passed, proctored: exam.proctored, violations: violations || 0,
      proctoringEvents: sanitizedEvents,
      terminatedByProctoring: false,
      topicAccuracy, xpEarned, certificateId: certificate?._id,
      hasCodingQuestions: hasCodingQuestions || hasDescriptiveQuestions,
    });

    if (certificate) { certificate.result = result._id; await certificate.save(); }
    if (inviteRecord) { inviteRecord.result = result._id; await inviteRecord.save(); }

    // Link pending screenshots to result
    if (pendingScreenshots.length > 0) {
      await Screenshot.updateMany(
        { _id: { $in: pendingScreenshots.map(s => s._id) } },
        { result: result._id }
      );
    }

    const user = await User.findById(req.user._id);
    if (settings.gamificationEnabled) { user.xp += xpEarned; user.updateLevel(); }
    user.totalExams += 1;
    user.totalScore += percentage;
    const weakTopics = detectWeakTopics(scoredAnswers, questionsForScoring);
    if (weakTopics.length) {
      user.weakTopics = [...new Set([...user.weakTopics, ...weakTopics])].slice(-10);
    }
    const today = new Date().toDateString();
    const yesterday = new Date(Date.now() - 86400000).toDateString();
    const lastExam = user.lastExamDate ? new Date(user.lastExamDate).toDateString() : null;
    if (lastExam === yesterday) user.streak += 1;
    else if (lastExam !== today) user.streak = 1;
    user.lastExamDate = new Date();
    await user.save({ validateBeforeSave: false });

    await Exam.findByIdAndUpdate(exam._id, { $inc: { timesAttempted: 1 } });

    // Invalidate result + analytics caches
    await delCache(
      `results:${req.user._id}`,
      `analytics:${exam.createdBy}`,
      `analytics_detailed:${exam.createdBy}`,
      `exams:${exam.createdBy}`,
    );

    await log({
      user: req.user, action: 'exam_submitted', category: 'exam',
      metadata: { examId, percentage, passed, violations, autoTerminated, passThreshold },
      ...fromReq(req),
      severity: violations > 0 ? 'warning' : 'info',
    });

    if (false && exam.proctored && settings.emailProctoringViolationEnabled) {
      // Notify student
      sendProctoringViolationEmail({
        email: user.email, name: user.name,
        examName: exam.title, violations,
        reason: 'Repeated proctoring violations detected',
      }).catch(logger.error);

      // Notify instructor by email and in-app notification
      const instructor = await User.findById(exam.createdBy).select('name email');
      if (instructor) {
        sendProctoringViolationEmail({
          email: instructor.email, name: instructor.name,
          examName: exam.title, violations,
          reason: `Student ${user.name} (${user.email}) was auto-terminated for repeated violations`,
        }).catch(logger.error);

        createNotificationsForUsers([instructor._id], {
          type: 'proctoring_violation',
          title: `Proctoring Violation — ${exam.title}`,
          message: `${user.name} was auto-terminated after ${violations} violation(s) during "${exam.title}".`,
          link: `/instructor/report/${exam._id}`,
          meta: { examId: exam._id, studentId: user._id, violations },
        }).catch(logger.error);
      }

      // Student in-app notification
      createNotificationsForUsers([user._id], {
        type: 'proctoring_violation',
        title: 'Exam Terminated — Proctoring Violations',
        message: `Your attempt on "${exam.title}" was terminated after ${violations} violation(s). Your result has been recorded.`,
        link: `/results/${result._id}`,
        meta: { examId: exam._id, violations },
      }).catch(logger.error);

      await log({ user: req.user, action: 'proctoring_terminated', category: 'proctoring', metadata: { examId, violations }, ...fromReq(req), severity: 'critical' });
    }

    if (settings.emailResultEnabled) {
      sendResultEmail({
        email: user.email, name: user.name, examName: exam.title,
        percentage, passed, certId: certificate?.certId, pdfBuffer,
      }).catch(logger.error);
    }

    res.status(201).json({
      result: {
        id: result._id, score: correctCount, total, percentage, passed,
        correctCount, incorrectCount, unattemptedCount, timeTaken,
        topicAccuracy, xpEarned, violations, passThreshold,
        terminatedByProctoring: false,
        proctoringEvents: sanitizedEvents,
        certificate: certificate ? { certId: certificate.certId, id: certificate._id } : null,
        showResultToUser:  exam.showResultToUser  !== false,
        showAnswersToUser: exam.showAnswersToUser  !== false,
        ...(exam.showAnswersToUser !== false && {
          answers: scoredAnswers,
          questions: questionsForScoring,
        }),
      },
    });
  } catch (err) { next(err); }
};

export const getMyResults = async (req, res, next) => {
  try {
    const key = `results:${req.user._id}`;
    const cached = await getCache(key);
    if (cached) return res.json(cached);

    const results = await Result.find({ user: req.user._id })
      .populate('exam', 'title subject difficulty')
      .sort({ createdAt: -1 }).limit(50);
    const payload = { results };
    await setCache(key, payload, 300);
    res.json(payload);
  } catch (err) { next(err); }
};

export const getResultById = async (req, res, next) => {
  try {
    const result = await Result.findById(req.params.id).populate('exam');
    if (!result) return next(new AppError('Result not found', 404));

    const isOwner = result.user.toString() === req.user._id.toString();
    const isAdmin = req.user.role === 'admin';
    const isExamOwner = result.exam?.createdBy?.toString() === req.user._id.toString();

    if (!isOwner && !isAdmin && !isExamOwner) {
      return next(new AppError('Not authorized', 403));
    }

    const exam = result.exam;
    const showAnswers = isAdmin || isExamOwner || exam?.showAnswersToUser !== false;
    const showResult  = isAdmin || isExamOwner || exam?.showResultToUser  !== false;

    // Build response object respecting visibility
    const resultObj = result.toObject();
    if (!showAnswers) {
      delete resultObj.answers;
      if (resultObj.exam) delete resultObj.exam.questions;
    }

    res.json({
      result: {
        ...resultObj,
        showResultToUser:  showResult,
        showAnswersToUser: showAnswers,
      },
    });
  } catch (err) { next(err); }
};
