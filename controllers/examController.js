import http from 'http';
import https from 'https';
import { AppError } from '../middleware/errorHandler.js';
import Exam from '../models/Exam.js';
import ExamInvite from '../models/ExamInvite.js';
import Group from '../models/Group.js';
import Resource from '../models/Resource.js';
import Screenshot from '../models/Screenshot.js';
import {
    analyzeProctoringImage,
    generateCodingQuestions, generateDescriptiveQuestions, generateMCQs,
    generateQuestionsFromText, generateSingleQuestion,
} from '../services/aiService.js';
import { delCache, getCache, setCache } from '../services/cacheService.js';
import { isCloudinaryConfigured, uploadScreenshot } from '../services/cloudinaryService.js';
import logger from '../utils/logger.js';

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
    } = req.body;
    const user = req.user;

    if (!user.canCreateExam()) {
      return next(new AppError(
        `Monthly exam limit reached (${user.getMonthlyLimit()} on ${user.getEffectivePlan()} plan). Upgrade your plan or wait until next month.`,
        429
      ));
    }

    const maxQ = user.getMaxQuestions();
    const requestedQ = Number(numQuestions);
    if (requestedQ > maxQ) {
      return next(new AppError(`Your ${user.getEffectivePlan()} plan allows up to ${maxQ} questions per exam.`, 403));
    }

    if (proctored && !user.canUseProctoring()) {
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
    if (resolvedContextText) {
      questions = await generateQuestionsFromText({ text: resolvedContextText, numQuestions: requestedQ, examType, difficulty });
    } else if (enableCoding || examType === 'coding') {
      questions = await generateCodingQuestions({ subject, difficulty, numQuestions: requestedQ, topics });
    } else if (examType === 'descriptive') {
      questions = await generateDescriptiveQuestions({ subject, difficulty, numQuestions: requestedQ, topics });
    } else if (examType === 'mixed') {
      const half = Math.ceil(requestedQ / 2);
      const [mcqs, desc] = await Promise.all([
        generateMCQs({ subject, difficulty, numQuestions: half, topics }),
        generateDescriptiveQuestions({ subject, difficulty, numQuestions: requestedQ - half, topics }),
      ]);
      questions = [...mcqs, ...desc];
    } else {
      questions = await generateMCQs({ subject, difficulty, numQuestions: requestedQ, topics });
    }

    // Time per question: explicit or derive from difficulty
    const tpq = timePerQuestion
      ? Math.max(10, Math.min(600, Number(timePerQuestion)))
      : ({ easy: 45, medium: 60, hard: 90 }[difficulty] || 60);

    const exam = await Exam.create({
      title, subject, difficulty,
      examType: enableCoding ? 'coding' : examType,
      topics: topics || [],
      questions,
      createdBy: user._id,
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

    user.examsCreatedThisMonth = (user.examsCreatedThisMonth || 0) + 1;
    user.examCreationsToday = (user.examCreationsToday || 0) + 1;
    user.lastExamCreationDate = new Date();
    await user.save({ validateBeforeSave: false });

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

    const { questions } = req.body;
    if (!Array.isArray(questions) || questions.length === 0) {
      return next(new AppError('questions array is required', 400));
    }

    exam.questions = questions;
    await exam.save();
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
    if (req.body.subject)    exam.subject    = req.body.subject;
    if (req.body.difficulty) exam.difficulty = req.body.difficulty;
    if (req.body.topics)     exam.topics     = req.body.topics;
    await exam.save();

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
    exam.markModified('questions');
    await exam.save();

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
    const payload = { exams };
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

export const getExamById = async (req, res, next) => {
  try {
    const exam = await Exam.findById(req.params.id);
    if (!exam) return next(new AppError('Exam not found', 404));
    const isOwner = exam.createdBy.toString() === req.user._id.toString();
    if (!exam.isPublic && !isOwner && req.user.role !== 'admin') {
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
    if (!isOwner && req.user.role !== 'admin' && exam.expiryDate && new Date(exam.expiryDate) < new Date()) {
      return next(new AppError('This test has expired', 403));
    }
    res.json({ exam });
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
