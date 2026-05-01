import express from 'express';
import multer from 'multer';
import {
  analyzeProctoringFrame,
  createExam, deleteExam, executeCode, getExamById, getMyExams, getPublicExams,
  parsePDF, regenerateExam, regenerateQuestion, saveScreenshot, updateExam, updateQuestions,
} from '../controllers/examController.js';
import { protect } from '../middleware/auth.js';
import { examCreationLimiter } from '../middleware/rateLimiter.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const allowed = ['application/pdf', 'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    cb(null, allowed.includes(file.mimetype));
  },
});

const router = express.Router();

router.get('/public', protect, getPublicExams);
router.use(protect);
router.post('/execute-code', executeCode);
router.post('/parse-pdf', upload.single('file'), parsePDF);
router.post('/analyze-proctoring', analyzeProctoringFrame);
router.post('/', examCreationLimiter, createExam);
router.get('/', getMyExams);
router.get('/:id', getExamById);
router.put('/:id', updateExam);
router.put('/:id/questions', updateQuestions);
router.delete('/:id', deleteExam);
router.post('/:id/regenerate', regenerateExam);
router.post('/:id/regenerate-question/:index', regenerateQuestion);
router.post('/:id/screenshot', saveScreenshot);

export default router;
