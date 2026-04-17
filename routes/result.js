import express from 'express';
import { getMyResults, getResultById, submitResult } from '../controllers/resultController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

router.use(protect);
router.post('/', submitResult);
router.get('/', getMyResults);
router.get('/:id', getResultById);

export default router;
