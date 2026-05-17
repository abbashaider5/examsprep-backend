import { AppError } from '../middleware/errorHandler.js';
import Exam from '../models/Exam.js';
import ExamInvite from '../models/ExamInvite.js';
import Group from '../models/Group.js';
import Enterprise from '../models/Enterprise.js';
import { enterpriseSubscriptionIsActive } from '../services/subscriptionLifecycleService.js';
import Resource from '../models/Resource.js';
import ResourceChunk from '../models/ResourceChunk.js';
import { retrieveGroundingContext } from '../services/resourceRetrievalService.js';
import { enqueueResourceProcessing } from '../services/resourceProcessingService.js';
import Screenshot from '../models/Screenshot.js';
import User from '../models/User.js';
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
  generateCodingQuestions, generateDescriptiveQuestions, generateGroundedExamQuestions, generateListeningExamQuestions,
  generateMCQs,
  generateQuestionsFromText, generateSingleListeningQuestion, generateSingleQuestion,
} from '../services/aiService.js';
import { delCache, getCache, setCache } from '../services/cacheService.js';
import { buildInstructorExamReportData } from '../utils/instructorExamReportData.js';
import { isCloudinaryConfigured, signedAuthenticatedMediaUrl, uploadScreenshot, downloadStoredResourceBuffer } from '../services/cloudinaryService.js';
import { interleaveListeningEvenly, synthesizeAndAttachListeningAudio } from '../services/examListeningService.js';
import { isCambAiTtsConfigured, synthesizeExamNarration } from '../services/tts/ttsService.js';
import { previewSampleTextForStyle, voiceMetaFromAccent } from '../utils/listeningVoicePresets.js';
import logger from '../utils/logger.js';
import { log, fromReq } from '../utils/activityLogger.js';
import { cleanExtractedText, cleanOcrExtractedText, cleanPdfExtractedText } from '../services/resourceChunkingService.js';
import { extractTextFromResourceBuffer } from '../services/resourceTextExtraction.js';
import {
  computeExamUsageSnapshot,
  consumeExamGenerationSlots,
  effectivePlanTypeWithEnterprise,
  getMaxQuestionsForUser,
} from '../services/subscriptionUsageService.js';

const normalizeExtractedForExam = (ex) => {
  const raw = ex?.text || '';
  const isPdf = ex?.format === 'pdf' || ex?.format === 'pdf_ocr';
  if (isPdf) return cleanPdfExtractedText(raw);
  return ex?.usedOcr ? cleanOcrExtractedText(raw) : cleanExtractedText(raw);
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
    const user = await User.findById(req.user._id);
    if (!user) return next(new AppError('User not found', 401));

    const multipleSets = Boolean(req.body.multipleSets);
    let enterpriseConfig = null;
    if (user.enterpriseId && (user.role === 'instructor' || user.role === 'principal')) {
      enterpriseConfig = await Enterprise.findById(user.enterpriseId)
        .select('examsPerTeacherLimit questionsPerExamLimit aiProctoringEnabled orgPlanExpiresAt orgTrialEndsAt')
        .lean();
    }
    const usageMultiplier = multipleSets ? 3 : 1;
    const orgActive = enterpriseSubscriptionIsActive(enterpriseConfig);
    const entExamCap = (user.enterpriseId && (user.role === 'instructor' || user.role === 'principal') && orgActive)
      ? enterpriseConfig?.examsPerTeacherLimit
      : null;
    const usageSnap = await computeExamUsageSnapshot(user._id, entExamCap ?? null);
    if (!usageSnap) return next(new AppError('Could not verify usage limits.', 500));
    if (usageSnap.remaining < usageMultiplier) {
      return next(new AppError(
        multipleSets
          ? `Multiple Sets uses ${usageMultiplier} of your monthly test slots. You need ${usageMultiplier} free slot(s) but only have ${usageSnap.remaining} remaining.`
          : 'You have reached your exam generation limit for this billing period.',
        429,
        { code: 'EXAM_LIMIT_REACHED' },
      ));
    }

    const maxQ = await getMaxQuestionsForUser(user, enterpriseConfig?.questionsPerExamLimit ?? null);
    const requestedQ = Number(numQuestions);
    if (requestedQ > maxQ) {
      return next(new AppError(`Your plan allows up to ${maxQ} questions per exam.`, 403));
    }

    if (proctored && enterpriseConfig && enterpriseConfig.aiProctoringEnabled === false) {
      return next(new AppError('AI Proctoring is not enabled in your enterprise plan. Please contact your administrator.', 403));
    }
    if (proctored && !['pro', 'enterprise'].includes(effectivePlanTypeWithEnterprise(user, enterpriseConfig))) {
      return next(new AppError('AI Proctoring requires a Pro or Enterprise plan.', 403));
    }

    if (enableCoding && effectivePlanTypeWithEnterprise(user, enterpriseConfig) !== 'enterprise') {
      return next(new AppError('Coding questions require an Enterprise plan.', 403));
    }

    // Resolve resource-backed generation (RAG) or legacy full-document text
    let sourceResourceId = null;
    let resolvedContextText = contextText || '';

    if (resourceId && !(enableCoding || examType === 'coding')) {
      const resource = await Resource.findById(resourceId).select(
        'cloudinaryUrl cloudinaryPublicId title scope uploadedBy subject processingStatus processingErrorMessage chunkCount mimetype originalName',
      );
      if (!resource) {
        return next(new AppError('Resource not found', 404));
      }
      const canAccess = resource.scope === 'admin'
        || resource.uploadedBy.toString() === user._id.toString()
        || user.role === 'admin';
      if (!canAccess) {
        return next(new AppError('Not authorized to use this resource', 403));
      }

      const st = resource.processingStatus;
      if (st === 'processing' || st === 'uploading') {
        return next(new AppError(
          'This resource is still being read and indexed. Wait until AI processing finishes, then create your exam.',
          409,
        ));
      }
      if (st === 'failed') {
        return next(new AppError(
          resource.processingErrorMessage || 'This resource failed AI processing. Retry indexing or upload again.',
          422,
        ));
      }

      const indexed = (resource.chunkCount > 0)
        || (await ResourceChunk.countDocuments({ resource: resource._id })) > 0;

      if (indexed && st === 'ready') {
        const { context } = await retrieveGroundingContext(resource._id, {
          subject: subject || resource.subject || resource.title || 'General',
          topics: topics || [],
          maxChars: 16_000,
          topK: 26,
        });
        if (!context || context.length < 50) {
          return next(new AppError(
            'Not enough indexed content could be retrieved from this resource. Try re-uploading or broadening topics.',
            422,
          ));
        }
        sourceResourceId = resource._id;
        resolvedContextText = `__RAG__:${context}`;
      } else if (resource.cloudinaryUrl) {
        // Legacy resources (no vector index yet): one-shot text extraction, then queue indexing for next time
        try {
          const buf = await downloadStoredResourceBuffer({
            cloudinaryUrl: resource.cloudinaryUrl,
            cloudinaryPublicId: resource.cloudinaryPublicId,
          });
          const ex = await extractTextFromResourceBuffer(buf, resource.originalName, resource.mimetype);
          const text = normalizeExtractedForExam(ex).slice(0, 60000);
          if (!text || text.length < 80) {
            return next(new AppError('Could not read enough text from this resource. Try a DOCX or other supported format.', 422));
          }
          resolvedContextText = text;
          sourceResourceId = resource._id;
          enqueueResourceProcessing(resource._id);
        } catch (fetchErr) {
          logger.warn('[createExam] Resource fetch/parse failed: ' + fetchErr.message);
          return next(new AppError('Could not read this resource file. Check the format or try again.', 422));
        }
      } else {
        return next(new AppError('Resource file is not available.', 404));
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

    const examTypeEff = enableCoding ? 'coding' : examType;
    const RAG_PREFIX = '__RAG__:';

    const instructorLike = ['instructor', 'admin', 'principal'].includes(user.role);
    const wantListen = Boolean(req.body.includeListeningQuestions)
      && instructorLike
      && !enableCoding && examType !== 'coding';
    let listenCount = 0;
    if (wantListen) {
      const rawLc = Number(req.body.listeningQuestionCount);
      listenCount = Math.min(15, Math.max(1, Number.isFinite(rawLc) ? rawLc : 1));
      listenCount = Math.min(listenCount, Math.max(1, requestedQ - 1));
    }
    const regularTotal = requestedQ - listenCount;
    const replayLimitListening = (() => {
      const mode = String(req.body.audioReplayMode || 'unlimited').toLowerCase();
      const maxN = Number(req.body.audioReplayMax);
      if (mode === 'once') return 1;
      if (mode === 'limited') return Math.max(2, Math.min(20, Number.isFinite(maxN) ? maxN : 3));
      return undefined;
    })();
    if (listenCount > 0) {
      if (!isCambAiTtsConfigured()) {
        return next(new AppError('Listening questions require CAMB_AI_API_KEY to be configured on the server.', 422));
      }
      if (!isCloudinaryConfigured()) {
        return next(new AppError('Listening questions require Cloudinary to be configured for secure audio storage.', 422));
      }
    }
    const genQ = listenCount > 0 ? regularTotal : requestedQ;

    if (enableCoding || examTypeEff === 'coding') {
      questions = await generateCodingQuestions({ subject, difficulty, numQuestions: requestedQ, topics });
    } else if (resolvedContextText.startsWith(RAG_PREFIX)) {
      const ctx = resolvedContextText.slice(RAG_PREFIX.length);
      questions = await generateGroundedExamQuestions({
        context: ctx,
        subject,
        numQuestions: genQ,
        examType: examTypeEff,
        difficulty,
        mixedMcqPercent,
        topics: topics || [],
      });
    } else if (resolvedContextText) {
      questions = await generateQuestionsFromText({
        text: resolvedContextText, numQuestions: genQ, examType: examTypeEff, difficulty, mixedMcqPercent, topics: topics || [],
      });
    } else if (examTypeEff === 'descriptive') {
      questions = await generateDescriptiveQuestions({ subject, difficulty, numQuestions: genQ, topics });
    } else if (examTypeEff === 'mixed') {
      const { mcqCount, descCount } = splitMixed(genQ, mixedMcqPercent);
      const [mcqs, desc] = await Promise.all([
        mcqCount > 0 ? generateMCQs({ subject, difficulty, numQuestions: mcqCount, topics }) : Promise.resolve([]),
        descCount > 0 ? generateDescriptiveQuestions({ subject, difficulty, numQuestions: descCount, topics }) : Promise.resolve([]),
      ]);
      questions = [...mcqs, ...desc];
    } else {
      questions = await generateMCQs({ subject, difficulty, numQuestions: genQ, topics });
    }

    if (listenCount > 0) {
      const listeningVoiceAccent = String(req.body.listeningVoiceAccent || 'american').toLowerCase();
      const listeningNarrationStyle = String(req.body.listeningNarrationStyle || 'academic').toLowerCase();
      const hasResourceForListen = Boolean(resourceId && resolvedContextText);
      const listeningResourceGrounded = hasResourceForListen && req.body.listeningResourceGrounded !== false;

      let groundedListen = false;
      let ctxRag = '';
      let ctxText = '';
      if (listeningResourceGrounded) {
        if (resolvedContextText.startsWith(RAG_PREFIX)) {
          groundedListen = true;
          ctxRag = resolvedContextText.slice(RAG_PREFIX.length);
        } else if (resolvedContextText.length > 80) {
          ctxText = resolvedContextText;
        }
      }
      const listeningBatch = await generateListeningExamQuestions({
        subject,
        numQuestions: listenCount,
        difficulty,
        topics: topics || [],
        replayLimit: replayLimitListening,
        grounded: groundedListen,
        context: ctxRag,
        contextText: groundedListen ? '' : ctxText,
        narrationStyle: listeningNarrationStyle,
      });
      questions = interleaveListeningEvenly(questions, listeningBatch);
      questions = await synthesizeAndAttachListeningAudio(questions, { accent: listeningVoiceAccent });
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
      sourceResource:      sourceResourceId || null,
      includeListeningQuestions: listenCount > 0,
      listeningQuestionCount: listenCount,
      listeningVoiceAccent: listenCount > 0 ? String(req.body.listeningVoiceAccent || 'american').toLowerCase() : undefined,
      listeningNarrationStyle: listenCount > 0 ? String(req.body.listeningNarrationStyle || 'academic').toLowerCase() : undefined,
      listeningResourceGrounded: listenCount > 0
        ? (Boolean(resourceId && resolvedContextText) && req.body.listeningResourceGrounded !== false)
        : undefined,
    });

    const updatedUser = await consumeExamGenerationSlots(user._id, usageMultiplier, entExamCap ?? null);
    if (!updatedUser) {
      await Exam.deleteOne({ _id: exam._id });
      return next(new AppError(
        'Your exam generation limit was reached while creating this test. Please try again or upgrade your plan.',
        429,
        { code: 'EXAM_LIMIT_REACHED' },
      ));
    }

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
    const examTypeEff = enableCoding ? 'coding' : (exam.examType || 'mcq');

    const wantListen = Boolean(req.body.includeListeningQuestions ?? exam.includeListeningQuestions)
      && ['instructor', 'admin', 'principal'].includes(req.user.role)
      && !enableCoding && examTypeEff !== 'coding';
    let listenCount = 0;
    if (wantListen) {
      const rawLc = Number(req.body.listeningQuestionCount ?? exam.listeningQuestionCount);
      listenCount = Math.min(15, Math.max(1, Number.isFinite(rawLc) ? rawLc : 1));
      listenCount = Math.min(listenCount, Math.max(1, numQ - 1));
    }
    const regularTotal = numQ - listenCount;
    const replayLimitListening = (() => {
      if (req.body.audioReplayMode !== undefined && req.body.audioReplayMode !== null) {
        const mode = String(req.body.audioReplayMode || 'unlimited').toLowerCase();
        const maxN = Number(req.body.audioReplayMax);
        if (mode === 'once') return 1;
        if (mode === 'limited') return Math.max(2, Math.min(20, Number.isFinite(maxN) ? maxN : 3));
        return undefined;
      }
      const prev = exam.questions.find((q) => q.isAudioQuestion && typeof q.replayLimit === 'number');
      return prev?.replayLimit;
    })();
    if (listenCount > 0) {
      if (!isCambAiTtsConfigured()) {
        return next(new AppError('Listening questions require CAMB_AI_API_KEY to be configured on the server.', 422));
      }
      if (!isCloudinaryConfigured()) {
        return next(new AppError('Listening questions require Cloudinary to be configured for secure audio storage.', 422));
      }
    }
    const genQ = listenCount > 0 ? regularTotal : numQ;

    let questions;

    if (enableCoding || examTypeEff === 'coding') {
      questions = await generateCodingQuestions({ subject, difficulty, numQuestions: numQ, topics });
    } else if (exam.sourceResource) {
      const resDoc = await Resource.findById(exam.sourceResource).select('processingStatus chunkCount');
      const st = resDoc?.processingStatus;
      if (st === 'processing' || st === 'uploading') {
        return next(new AppError('Resource is still being indexed. Try again shortly.', 409));
      }
      if (st === 'failed') {
        return next(new AppError('Linked resource failed processing. Re-link a ready resource or remove source.', 422));
      }
      const indexed = (resDoc?.chunkCount > 0)
        || (await ResourceChunk.countDocuments({ resource: exam.sourceResource })) > 0;
      if (indexed && st === 'ready') {
        const { context } = await retrieveGroundingContext(exam.sourceResource, {
          subject,
          topics: topics || [],
          maxChars: 16_000,
          topK: 26,
        });
        if (!context || context.length < 50) {
          return next(new AppError('Could not retrieve enough content from the linked resource.', 422));
        }
        questions = await generateGroundedExamQuestions({
          context,
          subject,
          numQuestions: genQ,
          examType: examTypeEff,
          difficulty,
          mixedMcqPercent: req.body.mixedMcqPercent ?? 50,
          topics: topics || [],
        });
      } else {
        /* legacy exam + resource */
        const resource = await Resource.findById(exam.sourceResource).select('cloudinaryUrl cloudinaryPublicId originalName mimetype');
        if (!resource?.cloudinaryUrl) {
          return next(new AppError('Linked resource file is missing.', 404));
        }
        const buf = await downloadStoredResourceBuffer({
          cloudinaryUrl: resource.cloudinaryUrl,
          cloudinaryPublicId: resource.cloudinaryPublicId,
        });
        const ex = await extractTextFromResourceBuffer(buf, resource.originalName, resource.mimetype);
        const text = normalizeExtractedForExam(ex).slice(0, 60000);
        if (!text || text.length < 40) {
          return next(new AppError('Could not extract text from linked resource.', 422));
        }
        questions = await generateQuestionsFromText({
          text,
          numQuestions: genQ,
          examType: examTypeEff,
          difficulty,
          mixedMcqPercent: req.body.mixedMcqPercent ?? 50,
          topics: topics || [],
        });
      }
    } else if (examTypeEff === 'descriptive') {
      questions = await generateDescriptiveQuestions({ subject, difficulty, numQuestions: genQ, topics });
    } else if (examTypeEff === 'mixed') {
      const pct = req.body.mixedMcqPercent ?? 50;
      let p = Number(pct);
      if (!Number.isFinite(p)) p = 50;
      p = Math.max(10, Math.min(90, Math.round(p)));
      let mcqCount = genQ <= 1 ? (p >= 50 ? 1 : 0) : Math.max(1, Math.min(genQ - 1, Math.round((genQ * p) / 100)));
      let descCount = genQ - mcqCount;
      if (genQ <= 1) descCount = genQ - mcqCount;
      const [mcqs, desc] = await Promise.all([
        mcqCount > 0 ? generateMCQs({ subject, difficulty, numQuestions: mcqCount, topics }) : Promise.resolve([]),
        descCount > 0 ? generateDescriptiveQuestions({ subject, difficulty, numQuestions: descCount, topics }) : Promise.resolve([]),
      ]);
      questions = [...mcqs, ...desc];
    } else {
      questions = await generateMCQs({ subject, difficulty, numQuestions: genQ, topics });
    }

    if (listenCount > 0) {
      const listeningVoiceAccent = String(req.body.listeningVoiceAccent ?? exam.listeningVoiceAccent ?? 'american').toLowerCase();
      const listeningNarrationStyle = String(req.body.listeningNarrationStyle ?? exam.listeningNarrationStyle ?? 'academic').toLowerCase();
      const lrg = req.body.listeningResourceGrounded !== undefined
        ? req.body.listeningResourceGrounded !== false
        : (exam.listeningResourceGrounded !== false);

      let groundedListen = false;
      let ctxRag = '';
      let ctxText = '';
      if (lrg && exam.sourceResource) {
        const rd = await Resource.findById(exam.sourceResource).select('processingStatus chunkCount');
        const indexed = (rd?.chunkCount > 0)
          || (await ResourceChunk.countDocuments({ resource: exam.sourceResource })) > 0;
        if (indexed && rd?.processingStatus === 'ready') {
          const { context } = await retrieveGroundingContext(exam.sourceResource, {
            subject,
            topics: topics || [],
            maxChars: 16_000,
            topK: 26,
          });
          if (context && context.length > 50) {
            groundedListen = true;
            ctxRag = context;
          }
        }
      }
      const listeningBatch = await generateListeningExamQuestions({
        subject,
        numQuestions: listenCount,
        difficulty,
        topics: topics || [],
        replayLimit: replayLimitListening,
        grounded: groundedListen,
        context: ctxRag,
        contextText: ctxText,
        narrationStyle: listeningNarrationStyle,
      });
      questions = interleaveListeningEvenly(questions, listeningBatch);
      questions = await synthesizeAndAttachListeningAudio(questions, { accent: listeningVoiceAccent });
    }

    exam.questions = questions;
    exam.multipleSets = false;
    exam.questionVariants = null;
    if (req.body.subject)    exam.subject    = req.body.subject;
    if (req.body.difficulty) exam.difficulty = req.body.difficulty;
    if (req.body.topics)     exam.topics     = req.body.topics;
    exam.includeListeningQuestions = listenCount > 0;
    exam.listeningQuestionCount = listenCount;
    exam.listeningVoiceAccent = listenCount > 0
      ? String(req.body.listeningVoiceAccent ?? exam.listeningVoiceAccent ?? 'american').toLowerCase()
      : undefined;
    exam.listeningNarrationStyle = listenCount > 0
      ? String(req.body.listeningNarrationStyle ?? exam.listeningNarrationStyle ?? 'academic').toLowerCase()
      : undefined;
    exam.listeningResourceGrounded = listenCount > 0
      ? (req.body.listeningResourceGrounded !== undefined
        ? req.body.listeningResourceGrounded !== false
        : exam.listeningResourceGrounded !== false)
      : undefined;
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

    if (targetQ?.isAudioQuestion) {
      let groundedContext = '';
      let groundedMode = false;
      if (exam.sourceResource && qType !== 'coding') {
        const resDoc = await Resource.findById(exam.sourceResource).select('processingStatus chunkCount');
        if (resDoc?.processingStatus === 'ready') {
          const indexed = (resDoc.chunkCount > 0)
            || (await ResourceChunk.countDocuments({ resource: exam.sourceResource })) > 0;
          if (indexed) {
            const { context } = await retrieveGroundingContext(exam.sourceResource, {
              subject: exam.subject,
              topics: exam.topics || [],
              maxChars: 14_000,
              topK: 22,
            });
            if (context && context.length > 50) {
              groundedContext = context;
              groundedMode = true;
            }
          }
        }
      }
      if (!isCambAiTtsConfigured() || !isCloudinaryConfigured()) {
        return next(new AppError('Regenerating listening items requires CAMB_AI_API_KEY and Cloudinary to be configured.', 422));
      }
      let newQuestion = await generateSingleListeningQuestion({
        subject: exam.subject,
        difficulty: exam.difficulty,
        topics: exam.topics || [],
        contextText: groundedContext || undefined,
        groundedMode,
        replayLimit: typeof targetQ.replayLimit === 'number' ? targetQ.replayLimit : undefined,
        existingQuestions: existing,
        narrationStyle: exam.listeningNarrationStyle || 'academic',
      });
      newQuestion.replayLimit = typeof targetQ.replayLimit === 'number' ? targetQ.replayLimit : newQuestion.replayLimit;
      const [hydrated] = await synthesizeAndAttachListeningAudio([newQuestion], {
        accent: exam.listeningVoiceAccent || 'american',
      });
      exam.questions[index] = hydrated;
    } else {
      let groundedContext = '';
      let groundedMode = false;
      if (exam.sourceResource && qType !== 'coding') {
        const resDoc = await Resource.findById(exam.sourceResource).select('processingStatus chunkCount');
        if (resDoc?.processingStatus === 'ready') {
          const indexed = (resDoc.chunkCount > 0)
            || (await ResourceChunk.countDocuments({ resource: exam.sourceResource })) > 0;
          if (indexed) {
            const { context } = await retrieveGroundingContext(exam.sourceResource, {
              subject: exam.subject,
              topics: exam.topics || [],
              maxChars: 14_000,
              topK: 22,
            });
            if (context && context.length > 50) {
              groundedContext = context;
              groundedMode = true;
            }
          }
        }
      }

      const newQuestion = await generateSingleQuestion({
        subject: exam.subject,
        difficulty: exam.difficulty,
        examType: qType,
        existingQuestions: existing,
        topic: targetQ?.topic,
        contextText: groundedContext || undefined,
        groundedMode,
      });

      exam.questions[index] = newQuestion;
    }

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

/** POST /api/exams/:id/generate-question-from-topic — replace question at anchor with a new AI question for the given topic (distinct from regenerate-question). */
export const generateQuestionFromTopic = async (req, res, next) => {
  try {
    const exam = await Exam.findById(req.params.id);
    if (!exam) return next(new AppError('Exam not found', 404));
    if (exam.createdBy.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return next(new AppError('Not authorized', 403));
    }

    const topicRaw = typeof req.body.topic === 'string' ? req.body.topic.trim() : '';
    if (topicRaw.length < 2 || topicRaw.length > 400) {
      return next(new AppError('Enter a topic or concept (2–400 characters).', 400));
    }

    const anchorIndex = Number(req.body.anchorIndex);
    if (Number.isNaN(anchorIndex) || anchorIndex < 0 || anchorIndex >= exam.questions.length) {
      return next(new AppError('Invalid anchor question index.', 400));
    }

    const anchor = exam.questions[anchorIndex];
    if (anchor?.isAudioQuestion) {
      return next(new AppError('Generate from topic is not available for listening items.', 400));
    }

    const qType = anchor?.type || (exam.examType === 'mixed' ? 'mcq' : exam.examType) || 'mcq';

    let difficulty = exam.difficulty;
    const dBody = req.body.difficulty;
    if (dBody === 'easy' || dBody === 'medium' || dBody === 'hard') difficulty = dBody;

    const guidance = typeof req.body.guidance === 'string' ? req.body.guidance.trim().slice(0, 800) : '';
    const questionStyle = typeof req.body.questionStyle === 'string' ? req.body.questionStyle.trim().slice(0, 40) : '';

    let groundedContext = '';
    let groundedMode = false;
    if (exam.sourceResource && qType !== 'coding') {
      const resDoc = await Resource.findById(exam.sourceResource).select('processingStatus chunkCount');
      if (resDoc?.processingStatus === 'ready') {
        const indexed = (resDoc.chunkCount > 0)
          || (await ResourceChunk.countDocuments({ resource: exam.sourceResource })) > 0;
        if (indexed) {
          const retrievalTopics = [topicRaw, ...(exam.topics || [])]
            .map((t) => String(t).trim())
            .filter(Boolean)
            .slice(0, 18);
          const { context } = await retrieveGroundingContext(exam.sourceResource, {
            subject: exam.subject,
            topics: retrievalTopics,
            focusTopic: topicRaw,
            maxChars: 14_000,
            topK: 24,
          });
          if (context && context.length > 50) {
            groundedContext = context;
            groundedMode = true;
          }
        }
      }
    }

    const existingQuestions = exam.questions.filter((_, i) => i !== anchorIndex);

    const newQuestion = await generateSingleQuestion({
      subject: exam.subject,
      difficulty,
      examType: qType,
      existingQuestions,
      topic: topicRaw,
      contextText: groundedContext || undefined,
      groundedMode,
      extraGuidance: guidance || undefined,
      questionStyle: questionStyle || undefined,
    });

    exam.questions[anchorIndex] = newQuestion;
    exam.multipleSets = false;
    exam.questionVariants = null;
    exam.markModified('questions');
    await exam.save();
    await UserExamShuffle.deleteMany({ exam: exam._id });

    res.json({ question: newQuestion, index: anchorIndex });
  } catch (err) {
    next(err);
  }
};

/** POST /api/exams/parse-pdf — extract text from uploaded PDF */
export const parsePDF = async (req, res, next) => {
  try {
    if (!req.file) return next(new AppError('No file uploaded', 400));

    const ex = await extractTextFromResourceBuffer(
      req.file.buffer,
      req.file.originalname || 'upload.pdf',
      req.file.mimetype || 'application/pdf',
    );
    const text = normalizeExtractedForExam(ex);
    if (!text || text.length < 50) {
      return next(new AppError('Could not extract readable text from this PDF. Try a clearer scan or text-based PDF.', 422));
    }

    res.json({
      text: text.slice(0, 15000), // cap at 15k chars to avoid prompt overflow
      pages: ex.pages || 0,
      chars: text.length,
      usedOcr: Boolean(ex.usedOcr),
    });
  } catch (err) {
    next(err);
  }
};

/** POST /api/exams/:id/screenshot */
export const saveScreenshot = async (req, res, next) => {
  try {
    const {
      imageData: rawImageData,
      eventType = 'periodic_capture',
      eventSource = 'client',
      eventMessage = '',
      metadata = {},
    } = req.body;
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
    let cloudinaryPublicId = null;

    if (isCloudinaryConfigured()) {
      const uploaded = await uploadScreenshot(rawImageData);
      if (uploaded?.secureUrl) {
        imageUrl = uploaded.secureUrl;
        cloudinaryPublicId = uploaded.publicId || null;
      }
    }
    if (!imageUrl) {
      imageData = rawImageData;
    }

    const screenshot = await Screenshot.create({
      exam: exam._id,
      user: req.user._id,
      imageData,
      imageUrl,
      cloudinaryPublicId,
      eventType: String(eventType || 'periodic_capture').slice(0, 100),
      eventSource: String(eventSource || 'client').slice(0, 100),
      eventMessage: String(eventMessage || '').slice(0, 500),
      metadata: (metadata && typeof metadata === 'object')
        ? Object.fromEntries(
            Object.entries(metadata)
              .slice(0, 20)
              .map(([k, v]) => [String(k).slice(0, 60), String(v).slice(0, 200)]),
          )
        : {},
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

/** POST /api/exams/preview-listening-voice — short sample for teacher trust / UX */
export const previewListeningVoice = async (req, res, next) => {
  try {
    if (!['instructor', 'admin', 'principal'].includes(req.user.role)) {
      return next(new AppError('Not authorized', 403));
    }
    if (!isCambAiTtsConfigured()) {
      return next(new AppError('Voice preview requires CAMB_AI_API_KEY to be configured.', 422));
    }
    const accent = String(req.body?.accent || 'american').toLowerCase();
    const style = String(req.body?.style || 'academic').toLowerCase();
    const text = previewSampleTextForStyle(style);
    const voice = voiceMetaFromAccent(accent);
    const { buffer, contentType } = await synthesizeExamNarration(text, voice);
    if (buffer.length > 520_000) {
      return next(new AppError('Preview response too large.', 413));
    }
    const dataUrl = `data:${contentType || 'audio/wav'};base64,${buffer.toString('base64')}`;
    res.json({ dataUrl });
  } catch (err) {
    logger.warn(`[previewListeningVoice] ${err.message}`);
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

const mapQuestionListForAudioDelivery = (questions, mode) => {
  if (!Array.isArray(questions)) return questions;
  if (mode === 'student') {
    return questions.map((q) => {
      if (!q?.isAudioQuestion) return q;
      const o = { ...q };
      delete o.narrationText;
      delete o.audioTranscript;
      delete o.audioCloudinaryPublicId;
      delete o.audioUrl;
      o.audioRequiresToken = true;
      return o;
    });
  }
  if (mode === 'privileged') {
    return questions.map((q) => {
      if (!q?.isAudioQuestion || !q.audioCloudinaryPublicId) return q;
      return {
        ...q,
        audioUrl: signedAuthenticatedMediaUrl(q.audioCloudinaryPublicId, 900) || q.audioUrl || '',
      };
    });
  }
  return questions;
};

/** POST /api/exams/:id/audio-access — short-lived signed URL + replay accounting */
export const issueExamAudioAccess = async (req, res, next) => {
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
        if (!inGroup) return next(new AppError('Not authorized', 403));
      }
    }
    if (!isOwner && !isAdmin && exam.expiryDate && new Date(exam.expiryDate) < new Date()) {
      return next(new AppError('This test has expired', 403));
    }

    const qIndex = Number(req.body?.questionIndex);
    if (!Number.isInteger(qIndex) || qIndex < 0) {
      return next(new AppError('questionIndex is required', 400));
    }

    const variantIndex = await resolveVariantIndex(req.user, exam);
    const baseQuestions = getBaseQuestionsForExam(exam, variantIndex);
    let shuffle = await UserExamShuffle.findOne({ user: req.user._id, exam: exam._id });
    if (!shuffle) {
      return next(new AppError('Open the exam once to initialize your attempt, then try audio again.', 409));
    }
    if (shuffle.variantIndex !== variantIndex) {
      shuffle.variantIndex = variantIndex;
      const state = createUserShuffleState(baseQuestions);
      shuffle.questionOrder = state.questionOrder;
      shuffle.optionPermutations = state.optionPermutations;
      shuffle.audioPlayCounts = {};
      shuffle.markModified('audioPlayCounts');
      await shuffle.save();
    }

    const displayQs = buildDisplayQuestions(baseQuestions, shuffle);
    const q = displayQs[qIndex];
    if (!q?.isAudioQuestion || !q.audioCloudinaryPublicId) {
      return next(new AppError('This question does not have secured audio.', 400));
    }

    const limit = q.replayLimit;
    const counts = shuffle.audioPlayCounts && typeof shuffle.audioPlayCounts === 'object'
      ? { ...shuffle.audioPlayCounts }
      : {};
    const key = String(qIndex);
    const used = Number(counts[key]) || 0;

    if (typeof limit === 'number' && limit >= 1) {
      if (used >= limit) {
        return next(new AppError('Maximum audio replays reached for this question.', 403));
      }
      counts[key] = used + 1;
      shuffle.audioPlayCounts = counts;
      shuffle.markModified('audioPlayCounts');
      await shuffle.save();
    }

    const url = signedAuthenticatedMediaUrl(q.audioCloudinaryPublicId, 180);
    if (!url) {
      return next(new AppError('Could not issue a playback URL. Check Cloudinary configuration.', 502));
    }

    res.json({
      url,
      playsUsed: typeof limit === 'number' && limit >= 1 ? (Number(counts[key]) || 1) : null,
      playsMax: typeof limit === 'number' && limit >= 1 ? limit : null,
    });
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

    if (!isOwner && !isAdmin && !practiceMode && Array.isArray(payload.questions)) {
      payload.questions = mapQuestionListForAudioDelivery(payload.questions, 'student');
    } else if (practiceMode && !isOwner && !isAdmin && Array.isArray(payload.questions)) {
      payload.questions = mapQuestionListForAudioDelivery(payload.questions, 'student');
    }

    if (isOwner || isAdmin) {
      if (Array.isArray(payload.questions)) {
        payload.questions = mapQuestionListForAudioDelivery(payload.questions, 'privileged');
      }
      if (Array.isArray(payload.questionVariants)) {
        payload.questionVariants = payload.questionVariants.map((v) =>
          mapQuestionListForAudioDelivery(Array.isArray(v) ? v : [], 'privileged'),
        );
      }
    }

    if ((isOwner || isAdmin) && Array.isArray(payload.mergedQuestionsReview)) {
      payload.mergedQuestionsReview = payload.mergedQuestionsReview.map((row) => {
        const meta = row._reviewMeta;
        const { _reviewMeta, ...q } = row;
        const [mapped] = mapQuestionListForAudioDelivery([q], 'privileged');
        return { ...mapped, _reviewMeta: meta };
      });
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
