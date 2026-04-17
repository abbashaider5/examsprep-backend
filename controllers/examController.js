import { AppError } from '../middleware/errorHandler.js';
import Exam from '../models/Exam.js';
import ExamInvite from '../models/ExamInvite.js';
import Screenshot from '../models/Screenshot.js';
import User from '../models/User.js';
import { generateCodingQuestions, generateMCQs } from '../services/aiService.js';
import { isCloudinaryConfigured, uploadScreenshot } from '../services/cloudinaryService.js';


export const createExam = async (req, res, next) => {
  try {
    const {
      title, subject, difficulty, numQuestions, topics, proctored,
      passingPercentage, allowReattempt, showFlashcards, showReview,
      certificateEnabled, screenshotEnabled, enableCoding, allowCodeExecution,
      showResultToUser, showAnswersToUser,
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

    // Generate questions — all coding or all MCQ
    let questions;
    if (enableCoding) {
      questions = await generateCodingQuestions({ subject, difficulty, numQuestions: requestedQ, topics });
    } else {
      questions = await generateMCQs({ subject, difficulty, numQuestions: requestedQ, topics });
    }

    const exam = await Exam.create({
      title, subject, difficulty,
      topics: topics || [],
      questions,
      createdBy: user._id,
      proctored: Boolean(proctored),
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
    });

    user.examsCreatedThisMonth = (user.examsCreatedThisMonth || 0) + 1;
    user.examCreationsToday = (user.examCreationsToday || 0) + 1;
    user.lastExamCreationDate = new Date();
    await user.save({ validateBeforeSave: false });

    res.status(201).json({ exam });
  } catch (err) {
    next(err);
  }
};

/** PUT /api/exams/:id — edit exam metadata & settings (does not replace questions) */
export const updateExam = async (req, res, next) => {
  try {
    const exam = await Exam.findById(req.params.id);
    if (!exam) return next(new AppError('Exam not found', 404));
    if (exam.createdBy.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return next(new AppError('Not authorized', 403));
    }

    const allowed = [
      'title', 'subject', 'difficulty', 'topics', 'proctored',
      'allowReattempt', 'showFlashcards', 'showReview', 'certificateEnabled',
      'screenshotEnabled', 'enableCoding', 'allowCodeExecution',
      'showResultToUser', 'showAnswersToUser',
    ];
    allowed.forEach(key => {
      if (req.body[key] !== undefined) exam[key] = req.body[key];
    });

    if (req.body.passingPercentage !== undefined) {
      exam.passingPercentage = Math.max(1, Math.min(100, Number(req.body.passingPercentage) || 75));
    }

    await exam.save();
    res.json({ exam });
  } catch (err) {
    next(err);
  }
};

/** POST /api/exams/:id/regenerate — replace questions with freshly generated ones */
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

    res.json({ exam, message: 'Questions regenerated successfully' });
  } catch (err) {
    next(err);
  }
};

/** POST /api/exams/:id/screenshot — save a proctoring screenshot during an active exam */
export const saveScreenshot = async (req, res, next) => {
  try {
    const { imageData: rawImageData } = req.body;
    if (!rawImageData || typeof rawImageData !== 'string') {
      return next(new AppError('imageData is required', 400));
    }
    // base64 image data can be up to ~600KB in string length for a 640x480 JPEG
    if (rawImageData.length > 600000) {
      return next(new AppError('Screenshot image is too large (max ~450 KB)', 413));
    }

    const exam = await Exam.findById(req.params.id).select('screenshotEnabled proctored');
    if (!exam) return next(new AppError('Exam not found', 404));

    // Skip silently if exam is not proctored — screenshot makes no sense here
    if (!exam.proctored) {
      return res.json({ saved: false, reason: 'exam is not proctored' });
    }

    // Try Cloudinary first; fall back to base64 if not configured
    let imageUrl = null;
    let imageData = null;

    if (isCloudinaryConfigured()) {
      imageUrl = await uploadScreenshot(rawImageData);
    }
    if (!imageUrl) {
      // Cloudinary not configured or upload failed — store as base64 (size-limited)
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
    const exams = await Exam.find({ createdBy: req.user._id }).sort({ createdAt: -1 }).select('-questions');
    res.json({ exams });
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
      if (!invite) return next(new AppError('Not authorized to view this exam', 403));
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
    await exam.deleteOne();
    res.json({ message: 'Exam deleted successfully' });
  } catch (err) {
    next(err);
  }
};

/** POST /api/exams/execute-code — proxy code execution to Piston API */

// Piston uses different names for some languages than what the AI generates
const PISTON_LANG_MAP = {
  javascript: 'node', js: 'node',
  typescript: 'typescript', ts: 'typescript',
  python: 'python', python3: 'python',
  java: 'java',
  c: 'c',
  cpp: 'c++', 'c++': 'c++',
  csharp: 'csharp', 'c#': 'csharp',
  go: 'go',
  rust: 'rust',
  php: 'php',
  ruby: 'ruby',
  swift: 'swift',
  kotlin: 'kotlin',
  r: 'r',
};

export const executeCode = async (req, res, next) => {
  try {
    const { language = 'javascript', code, stdin = '' } = req.body;
    if (!code || typeof code !== 'string') {
      return next(new AppError('code is required', 400));
    }
    if (code.length > 50000) {
      return next(new AppError('Code too large (max 50KB)', 400));
    }

    const pistonLang = PISTON_LANG_MAP[language.toLowerCase()] || language.toLowerCase();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    let pistonRes;
    try {
      pistonRes = await fetch('https://emkc.org/api/v2/piston/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          language: pistonLang,
          version: '*',
          files: [{ content: code }],
          stdin,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    const data = await pistonRes.json().catch(() => ({}));

    if (!pistonRes.ok) {
      const msg = data?.message || 'Code execution service unavailable.';
      // Language not found is a user error, not a server error
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
    if (err.name === 'AbortError') {
      return next(new AppError('Code execution timed out.', 408));
    }
    next(err);
  }
};
