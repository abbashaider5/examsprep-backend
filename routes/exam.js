import express from 'express';
import {
  createExam, deleteExam, executeCode, getExamById, getMyExams, getPublicExams,
  regenerateExam, saveScreenshot, updateExam, updateQuestions,
} from '../controllers/examController.js';
import { protect } from '../middleware/auth.js';
import { examCreationLimiter } from '../middleware/rateLimiter.js';
import { examValidation, validate } from '../middleware/validation.js';

const router = express.Router();

router.get('/public', protect, getPublicExams);
router.use(protect);
router.post('/execute-code', executeCode);
router.post('/', examCreationLimiter, examValidation, validate, createExam);
router.get('/', getMyExams);
router.get('/:id', getExamById);
router.put('/:id', updateExam);
router.put('/:id/questions', updateQuestions);
router.delete('/:id', deleteExam);
router.post('/:id/regenerate', regenerateExam);
router.post('/:id/screenshot', saveScreenshot);

export default router;
