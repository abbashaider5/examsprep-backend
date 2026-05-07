import http from 'http';
import https from 'https';
import { AppError } from '../middleware/errorHandler.js';
import Exam from '../models/Exam.js';
import ExamInvite from '../models/ExamInvite.js';
import Group from '../models/Group.js';
import Enterprise from '../models/Enterprise.js';
import Resource from '../models/Resource.js';
import Screenshot from '../models/Screenshot.js';
import UserExamShuffle from '../models/UserExamShuffle.js';
import {
  buildDisplayQuestions,
  buildThreeQuestionVariants,
  createUserShuffleState,
  getBaseQuestionsForExam,
} from '../utils/examShuffleRuntime.js';
import crypto from 'crypto';
import {
    analyzeProctoringImage,
    generateCodingQuestions, generateDescriptiveQuestions, generateMCQs,
    generateQuestionsFromText, generateSingleQuestion,
} from '../services/aiService.js';
import { delCache, getCache, setCache } from '../services/cacheService.js';
import { buildInstructorExamReportData } from '../utils/instructorExamReportData.js';
import { isCloudinaryConfigured, uploadScreenshot } from '../services/cloudinaryService.js';
import logger from '../utils/logger.js';
import { log, fromReq } from '../utils/activityLogger.js';

const downloadBuffer = (url) => new Promise((resolve, reject) => {
  const lib = url.startsWith('https') ? https : http;
  lib.get(url, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  }).on('error', reject);
});

const parsePDFBuffer = async (buffer) => {
  const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js');
  const data = await pdfParse(buffer);
  return data.text?.trim() || '';
};

export const createExam = async (req, res, next) => {
  try {
    const {
      title, subject, difficulty = 'medium', numQuestions, topics, proctored,
      passingPercentage, allowReattempt, showFlashcards, showReview,
      certificateEnabled, screenshotEnabled, enableCoding, allowCodeExecution,
      showResultToUser, showAnswersToUser, expiryDate,
      examType = 'mcq', timePerQuestion, contextText, resourceId,
      mixedMcqPercent,
    } = req.body;
    const user = req.user;

    const multipleSets = Boolean(req.body.multipleSets);
    let enterpriseConfig = null;
    if (user.enterpriseId && (user.role === 'instructor' || user.role === 'principal')) {
      enterpriseConfig = await Enterprise.findById(user.enterpriseId)
        .select('examsPerTeacherLimit questionsPerExamLimit aiProctoringEnabled')
        .lean();
    }
    const usageMultiplier = multipleSets ? 3 : 1;
    user._syncMonthly();
    const monthlyLimit = enterpriseConfig?.examsPerTeacherLimit || user.getMonthlyLimit();
    const used = user.examsCreatedThisMonth || 0;
    if (used + usageMultiplier > monthlyLimit) {
      return next(new AppError(
        multipleSets
          ? `Multiple Sets uses 3 of your monthly test slots. You need ${usageMultiplier} free slot(s) but only have ${Math.max(0, monthlyLimit - used)} remaining (${monthlyLimit} on ${user.getEffectivePlan()} plan).`
          : `Monthly exam limit reached (${monthlyLimit} on ${user.getEffectivePlan()} plan). Upgrade your plan or wait until next month.`,
        429,
      ));
    }

    const maxQ = enterpriseConfig?.questionsPerExamLimit || user.getMaxQuestions();
    const requestedQ = Number(numQuestions);
    if (requestedQ > maxQ) {
      return next(new AppError(`Your ${user.getEffectivePlan()} plan allows up to ${maxQ} questions per exam.`, 403));
    }

    if (proctored && enterpriseConfig && enterpriseConfig.aiProctoringEnabled === false) {
      return next(new AppError('AI Proctoring is not enabled in your enterprise plan. Please contact your administrator.', 403));
    }
    if (proctored && !enterpriseConfig && !user.canUseProctoring()) {
      return next(new AppError('AI Proctoring requires a Pro or Enterprise plan.', 403));
    }

    if (enableCoding && user.getEffectivePlan() !== 'enterprise') {
      return next(new AppError('Coding questions require an Enterprise plan.', 403));
    }

    // Resolve context text — either passed directly or fetched from a resource
    let resolvedContextText = contextText || '';
    if (!resolvedContextText && resourceId) {
      const resource = await Resource.findById(resourceId).select('cloudinaryUrl title scope uploadedBy');
      if (resource) {
        // Access check: admin resources are open to all; instructor resources must be owned
        const canAccess = resource.scope === 'admin' || resource.uploadedBy.toString() === user._id.toString() || user.role === 'admin';
        if (canAccess && resource.cloudinaryUrl) {
          try {
            const buf = await downloadBuffer(resource.cloudinaryUrl);
            resolvedContextText = (await parsePDFBuffer(buf)).slice(0, 60000);
          } catch (fetchErr) {
            // Non-fatal: fall back to regular AI generation
            logger.warn('[createExam] Resource fetch/parse failed: ' + fetchErr.message);
          }
        }
      }
    }

    // Generate questions based on exam type and source
    let questions;
    const splitMixed = (total, pctRaw) => {
      let pct = Number(pctRaw);
      if (!Number.isFinite(pct)) pct = 50;
      pct = Math.max(10, Math.min(90, Math.round(pct)));
      if (total <= 1) {
        const mcqCount = pct >= 50 ? 1 : 0;
        return { mcqCount, descCount: total - mcqCount, pct };
      }
      let mcqCount = Math.round((total * pct) / 100);
      let descCount = total - mcqCount;
      mcqCount = Math.max(1, Math.min(total - 1, mcqCount));
      descCount = total - mcqCount;
      return { mcqCount, descCount, pct };
    };

    if (resolvedContextText) {
      questions = await generateQuestionsFromText({
        text: resolvedContextText, numQuestions: requestedQ, examType, difficulty, mixedMcqPercent,
      });
    } else if (enableCoding || examType === 'coding') {
      questions = await generateCodingQuestions({ subject, difficulty, numQuestions: requestedQ, topics });
    } else if (examType === 'descriptive') {
      questions = await generateDescriptiveQuestions({ subject, difficulty, numQuestions: requestedQ, topics });
    } else if (examType === 'mixed') {
      const { mcqCount, descCount } = splitMixed(requestedQ, mixedMcqPercent);
      const [mcqs, desc] = await Promise.all([
        mcqCount > 0 ? generateMCQs({ subject, difficulty, numQuestions: mcqCount, topics }) : Promise.resolve([]),
        descCount > 0 ? generateDescriptiveQuestions({ subject, difficulty, numQuestions: descCount, topics }) : Promise.resolve([]),
      ]);
      questions = [...mcqs, ...desc];
    } else {
      questions = await generateMCQs({ subject, difficulty, numQuestions: requestedQ, topics });
    }

    // Time per question: explicit or derive from difficulty
    const tpq = timePerQuestion
      ? Math.max(10, Math.min(600, Number(timePerQuestion)))
      : ({ easy: 45, medium: 60, hard: 90 }[difficulty] || 60);

    let questionVariants = null;
    let questionsToStore = questions;
    if (multipleSets) {
      questionVariants = buildThreeQuestionVariants(questions);
      questionsToStore = questionVariants[0];
    }

    const exam = await Exam.create({
      title, subject, difficulty,
      examType: enableCoding ? 'coding' : examType,
      topics: topics || [],
      questions: questionsToStore,
      multipleSets,
      questionVariants,
      createdBy: user._id,
      enterpriseId: user.enterpriseId || null,
      proctored: Boolean(proctored),
      timePerQuestion: tpq,
      passingPercentage:   Math.max(1, Math.min(100, Number(passingPercentage) || 75)),
      allowReattempt:      allowReattempt     !== undefined ? Boolean(allowReattempt)     : true,
      showFlashcards:      showFlashcards     !== undefined ? Boolean(showFlashcards)     : true,
      showReview:          showReview         !== undefined ? Boolean(showReview)         : true,
      certificateEnabled:  certificateEnabled !== undefined ? Boolean(certificateEnabled) : true,
      screenshotEnabled:   Boolean(screenshotEnabled),
      enableCoding:        Boolean(enableCoding),
      allowCodeExecution:  Boolean(allowCodeExecution),
      showResultToUser:    showResultToUser   !== undefined ? Boolean(showResultToUser)   : true,
      showAnswersToUser:   showAnswersToUser  !== undefined ? Boolean(showAnswersToUser)  : true,
      expiryDate:          expiryDate ? new Date(expiryDate) : null,
    });

    user.examsCreatedThisMonth = used + usageMultiplier;
    user.lifetimeExamsCreated = (user.lifetimeExamsCreated || 0) + usageMultiplier;
    user.examCreationsToday = (user.examCreationsToday || 0) + 1;
    user.lastExamCreationDate = new Date();
    await user.save({ validateBeforeSave: false });

    await log({
      user,
      action: 'exam_created',
      category: 'exam',
      enterprise: user.enterpriseId || undefined,
      metadata: { examId: exam._id.toString(), title: exam.title },
      ...fromReq(req),
    });

    // Invalidate exam/analytics caches
    await delCache(
      `exams:${user._id}`,
      `instructor_exams:${user._id}`,
      `analytics:${user._id}`,
    );

    res.status(201).json({ exam });
  } catch (err) {
    next(err);
  }
};

/** PUT /api/exams/:id — edit exam metadata & settings */
export const updateExam = async (req, res, next) => {
  try {
    const exam = await Exam.findById(req.params.id);
    if (!exam) return next(new AppError('Exam not found', 404));
    if (exam.createdBy.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return next(new AppError('Not authorized', 403));
    }

    const allowed = [
      'title', 'subject', 'difficulty', 'examType', 'topics', 'proctored',
      'allowReattempt', 'showFlashcards', 'showReview', 'certificateEnabled',
      'screenshotEnabled', 'enableCoding', 'allowCodeExecution',
      'showResultToUser', 'showAnswersToUser', 'timePerQuestion',
    ];
    allowed.forEach(key => {
      if (req.body[key] !== undefined) exam[key] = req.body[key];
    });

    if (req.body.passingPercentage !== undefined) {
      exam.passingPercentage = Math.max(1, Math.min(100, Number(req.body.passingPercentage) || 75));
    }
    if (req.body.timePerQuestion !== undefined) {
      exam.timePerQuestion = Math.max(10, Math.min(600, Number(req.body.timePerQuestion) || 60));
    }
    if (req.body.expiryDate !== undefined) {
      exam.expiryDate = req.body.expiryDate ? new Date(req.body.expiryDate) : null;
    }

    if (exam.proctored && req.user.enterpriseId && (req.user.role === 'instructor' || req.user.role === 'principal')) {
      const ent = await Enterprise.findById(req.user.enterpriseId).select('aiProctoringEnabled').lean();
      if (ent && ent.aiProctoringEnabled === false) {
        return next(new AppError('AI Proctoring is not enabled in your enterprise plan. Please contact your administrator.', 403));
      }
    }

    await exam.save();

    await delCache(`exams:${exam.createdBy}`, `instructor_exams:${exam.createdBy}`);

    res.json({ exam });
  } catch (err) {
    next(err);
  }
};

/** PUT /api/exams/:id/questions — replace the questions array */
export const updateQuestions = async (req, res, next) => {
  try {
    const exam = await Exam.findById(req.params.id);
    if (!exam) return next(new AppError('Exam not found', 404));
    if (exam.createdBy.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return next(new AppError('Not authorized', 403));
    }

    const { questions, questionVariants } = req.body;
    if (!Array.isArray(questions) || questions.length === 0) {
      return next(new AppError('questions array is required', 400));
    }

    const stripMeta = (q) => {
      if (!q || typeof q !== 'object') return q;
      const { _reviewMeta, ...rest } = q;
      return rest;
    };

    if (exam.multipleSets && Array.isArray(questionVariants) && questionVariants.length > 0) {
      const cleanedVariants = questionVariants.map((v) =>
        (Array.isArray(v) ? v : []).map((q) => stripMeta(q)),
      );
      exam.questionVariants = cleanedVariants;
      exam.questions = cleanedVariants[0]?.length ? cleanedVariants[0] : questions.map((q) => stripMeta(q));
    } else {
      exam.questions = questions.map((q) => stripMeta(q));
      exam.multipleSets = false;
      exam.questionVariants = null;
    }
    await exam.save();
    await UserExamShuffle.deleteMany({ exam: exam._id });
    res.json({ exam });
  } catch (err) {
    next(err);
  }
};

/** POST /api/exams/:id/regenerate — replace all questions */
export const regenerateExam = async (req, res, next) => {
  try {
    const exam = await Exam.findById(req.params.id);
    if (!exam) return next(new AppError('Exam not found', 404));
    if (exam.createdBy.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return next(new AppError('Not authorized', 403));
    }

    const subject    = req.body.subject    || exam.subject;
    const difficulty = req.body.difficulty || exam.difficulty;
    const numQ       = Number(req.body.numQuestions) || exam.questions.length;
    const topics     = req.body.topics     || exam.topics;
    const enableCoding = req.body.enableCoding !== undefined ? Boolean(req.body.enableCoding) : exam.enableCoding;

    let questions;
    if (enableCoding) {
      questions = await generateCodingQuestions({ subject, difficulty, numQuestions: numQ, topics });
    } else {
      questions = await generateMCQs({ subject, difficulty, numQuestions: numQ, topics });
    }

    exam.questions = questions;
    exam.multipleSets = false;
    exam.questionVariants = null;
    if (req.body.subject)    exam.subject    = req.body.subject;
    if (req.body.difficulty) exam.difficulty = req.body.difficulty;
    if (req.body.topics)     exam.topics     = req.body.topics;
    await exam.save();
    await UserExamShuffle.deleteMany({ exam: exam._id });

    await delCache(`exams:${exam.createdBy}`, `instructor_exams:${exam.createdBy}`);

    res.json({ exam, message: 'Questions regenerated successfully' });
  } catch (err) {
    next(err);
  }
};

/** POST /api/exams/:id/regenerate-question — replace a single question by index */
export const regenerateQuestion = async (req, res, next) => {
  try {
    const exam = await Exam.findById(req.params.id);
    if (!exam) return next(new AppError('Exam not found', 404));
    if (exam.createdBy.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return next(new AppError('Not authorized', 403));
    }

    const index = Number(req.params.index);
    if (isNaN(index) || index < 0 || index >= exam.questions.length) {
      return next(new AppError('Invalid question index', 400));
    }

    const existing = exam.questions.filter((_, i) => i !== index);
    const targetQ = exam.questions[index];
    const qType = targetQ?.type || exam.examType || 'mcq';

    const newQuestion = await generateSingleQuestion({
      subject: exam.subject,
      difficulty: exam.difficulty,
      examType: qType,
      existingQuestions: existing,
      topic: targetQ?.topic,
    });

    exam.questions[index] = newQuestion;
    exam.multipleSets = false;
    exam.questionVariants = null;
    exam.markModified('questions');
    await exam.save();
    await UserExamShuffle.deleteMany({ exam: exam._id });

    res.json({ question: exam.questions[index], index });
  } catch (err) {
    next(err);
  }
};

/** POST /api/exams/parse-pdf — extract text from uploaded PDF */
export const parsePDF = async (req, res, next) => {
  try {
    if (!req.file) return next(new AppError('No file uploaded', 400));

    // dynamic import to avoid top-level issues
    const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js');
    const data = await pdfParse(req.file.buffer);

    const text = data.text?.trim();
    if (!text || text.length < 50) {
      return next(new AppError('Could not extract readable text from this PDF. Try a text-based PDF.', 422));
    }

    res.json({
      text: text.slice(0, 15000), // cap at 15k chars to avoid prompt overflow
      pages: data.numpages,
      chars: text.length,
    });
  } catch (err) {
    next(err);
  }
};

/** POST /api/exams/:id/screenshot */
export const saveScreenshot = async (req, res, next) => {
  try {
    const { imageData: rawImageData } = req.body;
    if (!rawImageData || typeof rawImageData !== 'string') {
      return next(new AppError('imageData is required', 400));
    }
    if (rawImageData.length > 600000) {
      return next(new AppError('Screenshot image is too large (max ~450 KB)', 413));
    }

    const exam = await Exam.findById(req.params.id).select('screenshotEnabled proctored');
    if (!exam) return next(new AppError('Exam not found', 404));

    if (!exam.proctored) {
      return res.json({ saved: false, reason: 'exam is not proctored' });
    }

    let imageUrl = null;
    let imageData = null;

    if (isCloudinaryConfigured()) {
      imageUrl = await uploadScreenshot(rawImageData);
    }
    if (!imageUrl) {
      imageData = rawImageData;
    }

    const screenshot = await Screenshot.create({
      exam: exam._id,
      user: req.user._id,
      imageData,
      imageUrl,
    });

    res.status(201).json({ saved: true, screenshotId: screenshot._id });
  } catch (err) {
    next(err);
  }
};

export const getMyExams = async (req, res, next) => {
  try {
    const key = `exams:${req.user._id}`;
    const cached = await getCache(key);
    if (cached) return res.json(cached);

    const exams = await Exam.find({ createdBy: req.user._id }).sort({ createdAt: -1 }).select('-questions');
    const isInstructor = ['instructor', 'admin'].includes(req.user.role);
    const examsPayload = await Promise.all(
      exams.map(async (e) => {
        const plain = e.toObject();
        if (!isInstructor) {
          return { ...plain, attemptSummary: null };
        }
        try {
          const { summary } = await buildInstructorExamReportData(e);
          const notAttempted = Math.max(0, summary.totalParticipants - summary.attempted);
          return {
            ...plain,
            attemptSummary: {
              participants: summary.totalParticipants,
              uniqueAttempted: summary.attempted,
              passed: summary.passed,
              failed: summary.failed,
              notAttempted,
              totalSubmissions: summary.totalSubmissions,
            },
          };
        } catch {
          return {
            ...plain,
            attemptSummary: {
              participants: 0,
              uniqueAttempted: 0,
              passed: 0,
              failed: 0,
              notAttempted: 0,
              totalSubmissions: 0,
            },
          };
        }
      }),
    );
    const payload = { exams: examsPayload };
    await setCache(key, payload, 300);
    res.json(payload);
  } catch (err) {
    next(err);
  }
};

export const getPublicExams = async (req, res, next) => {
  try {
    const exams = await Exam.find({ isPublic: true })
      .populate('createdBy', 'name')
      .sort({ createdAt: -1 })
      .select('-questions');
    res.json({ exams });
  } catch (err) {
    next(err);
  }
};

async function resolveVariantIndex(user, exam) {
  const nVar = exam.multipleSets && Array.isArray(exam.questionVariants) && exam.questionVariants.length > 0
    ? exam.questionVariants.length
    : 1;
  if (nVar <= 1) return 0;
  const inv = await ExamInvite.findOne({
    exam: exam._id,
    email: user.email.toLowerCase(),
    status: { $in: ['pending', 'accepted'] },
  }).sort({ createdAt: -1 });
  if (
    inv
    && typeof inv.assignedVariantIndex === 'number'
    && inv.assignedVariantIndex >= 0
    && inv.assignedVariantIndex < nVar
  ) {
    return inv.assignedVariantIndex;
  }
  const sh = await UserExamShuffle.findOne({ user: user._id, exam: exam._id }).select('variantIndex');
  if (
    sh
    && typeof sh.variantIndex === 'number'
    && sh.variantIndex >= 0
    && sh.variantIndex < nVar
  ) {
    return sh.variantIndex;
  }
  return crypto.randomInt(0, nVar);
}

export const getExamById = async (req, res, next) => {
  try {
    const exam = await Exam.findById(req.params.id);
    if (!exam) return next(new AppError('Exam not found', 404));
    const isOwner = exam.createdBy.toString() === req.user._id.toString();
    const isAdmin = req.user.role === 'admin';
    if (!exam.isPublic && !isOwner && !isAdmin) {
      const invite = await ExamInvite.findOne({
        exam: exam._id,
        email: req.user.email.toLowerCase(),
        status: 'accepted',
      });
      if (!invite) {
        const inGroup = await Group.exists({
          'sharedExams.exam': exam._id,
          $or: [{ members: req.user._id }, { instructor: req.user._id }],
        });
        if (!inGroup) return next(new AppError('Not authorized to view this exam', 403));
      }
    }
    if (!isOwner && !isAdmin && exam.expiryDate && new Date(exam.expiryDate) < new Date()) {
      return next(new AppError('This test has expired', 403));
    }

    const practiceMode = req.query.practice === 'true';
    const payload = exam.toObject();

    if (!isOwner && !isAdmin && !practiceMode) {
      const variantIndex = await resolveVariantIndex(req.user, exam);
      const baseQuestions = getBaseQuestionsForExam(exam, variantIndex);
      let shuffle = await UserExamShuffle.findOne({ user: req.user._id, exam: exam._id });
      if (!shuffle) {
        const state = createUserShuffleState(baseQuestions);
        shuffle = await UserExamShuffle.create({
          user: req.user._id,
          exam: exam._id,
          variantIndex,
          questionOrder: state.questionOrder,
          optionPermutations: state.optionPermutations,
        });
      } else if (shuffle.variantIndex !== variantIndex) {
        shuffle.variantIndex = variantIndex;
        const state = createUserShuffleState(baseQuestions);
        shuffle.questionOrder = state.questionOrder;
        shuffle.optionPermutations = state.optionPermutations;
        await shuffle.save();
      }
      payload.questions = buildDisplayQuestions(baseQuestions, shuffle);
      delete payload.questionVariants;
    } else if (practiceMode && !isOwner && !isAdmin) {
      payload.questions = getBaseQuestionsForExam(exam, 0);
      delete payload.questionVariants;
    }

    // Instructor review: flat list of all questions across variants (multiple sets)
    if ((isOwner || isAdmin) && payload.multipleSets && Array.isArray(payload.questionVariants) && payload.questionVariants.length > 0) {
      payload.mergedQuestionsReview = payload.questionVariants.flatMap((variant, variantIndex) =>
        (Array.isArray(variant) ? variant : []).map((q, indexInVariant) => ({
          ...JSON.parse(JSON.stringify(q)),
          _reviewMeta: { variantIndex, indexInVariant },
        })),
      );
    }

    res.json({ exam: payload });
  } catch (err) {
    next(err);
  }
};

export const deleteExam = async (req, res, next) => {
  try {
    const exam = await Exam.findById(req.params.id);
    if (!exam) return next(new AppError('Exam not found', 404));
    if (exam.createdBy.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return next(new AppError('Not authorized', 403));
    }
    const createdBy = exam.createdBy.toString();
    await UserExamShuffle.deleteMany({ exam: exam._id });
    await exam.deleteOne();
    await delCache(
      `exams:${createdBy}`,
      `instructor_exams:${createdBy}`,
      `analytics:${createdBy}`,
      `analytics_detailed:${createdBy}`,
    );
    res.json({ message: 'Exam deleted successfully' });
  } catch (err) {
    next(err);
  }
};

const PISTON_LANG_MAP = {
  javascript: 'node', js: 'node',
  typescript: 'typescript', ts: 'typescript',
  python: 'python', python3: 'python',
  java: 'java', c: 'c',
  cpp: 'c++', 'c++': 'c++',
  csharp: 'csharp', 'c#': 'csharp',
  go: 'go', rust: 'rust', php: 'php',
  ruby: 'ruby', swift: 'swift', kotlin: 'kotlin', r: 'r',
};

export const executeCode = async (req, res, next) => {
  try {
    const { language = 'javascript', code, stdin = '' } = req.body;
    if (!code || typeof code !== 'string') return next(new AppError('code is required', 400));
    if (code.length > 50000) return next(new AppError('Code too large (max 50KB)', 400));

    const pistonLang = PISTON_LANG_MAP[language.toLowerCase()] || language.toLowerCase();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    let pistonRes;
    try {
      pistonRes = await fetch('https://emkc.org/api/v2/piston/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: pistonLang, version: '*', files: [{ content: code }], stdin }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    const data = await pistonRes.json().catch(() => ({}));
    if (!pistonRes.ok) {
      const msg = data?.message || 'Code execution service unavailable.';
      if (pistonRes.status === 400 && msg.toLowerCase().includes('runtime')) {
        return next(new AppError(`Language "${language}" is not supported for execution.`, 400));
      }
      return next(new AppError('Code execution service unavailable. Try again later.', 502));
    }

    res.json({
      stdout: data.run?.stdout || '',
      stderr: data.run?.stderr || '',
      output: data.run?.output || '',
      code:   data.run?.code ?? null,
    });
  } catch (err) {
    if (err.name === 'AbortError') return next(new AppError('Code execution timed out.', 408));
    next(err);
  }
};

// ── AI Proctoring: analyze a webcam frame ────────────────────────────────────
export const analyzeProctoringFrame = async (req, res, next) => {
  try {
    const { imageData } = req.body;
    if (!imageData) return next(new AppError('imageData is required', 400));

    // Strip data URI prefix if present
    const base64 = imageData.replace(/^data:image\/[a-z]+;base64,/, '');

    const result = await analyzeProctoringImage(base64);

    if (!result) {
      // Vision API unavailable — return neutral result so exam continues
      return res.json({ available: false, violations: [] });
    }

    const violations = [];

    if (result.faceCount === 0) {
      violations.push({ type: 'no_face', message: 'No face detected — please stay in frame.' });
    } else if (result.faceCount > 1) {
      violations.push({ type: 'multiple_faces', message: `Multiple faces detected (${result.faceCount}) — only you should be visible.` });
    }

    if (result.phoneDetected) {
      violations.push({ type: 'phone', message: 'Mobile phone detected in frame — remove it from view.' });
    }

    if (result.laptopDetected) {
      violations.push({ type: 'laptop', message: 'Secondary screen or laptop detected — only your exam screen is allowed.' });
    }
    if (result.bookDetected) {
      violations.push({ type: 'study_material', message: 'Books or study material detected — remove them from your desk area.' });
    }

    res.json({ available: true, violations, analysis: result.analysis, faceCount: result.faceCount });
  } catch (err) {
    next(err);
  }
};
