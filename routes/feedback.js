import express from 'express';
import { getFeedback, replyToFeedback, submitFeedback } from '../controllers/feedbackController.js';
import { protect, requireAdmin } from '../middleware/auth.js';

const router = express.Router();

router.post('/',                  protect,                       submitFeedback);
router.get('/admin',              protect, requireAdmin,          getFeedback);
router.patch('/admin/:id/reply',  protect, requireAdmin,          replyToFeedback);

export default router;
