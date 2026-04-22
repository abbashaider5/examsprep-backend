import express from 'express';
import { deleteNotification, getMyNotifications, markAllRead, markRead } from '../controllers/notificationController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();
router.use(protect);

router.get('/',               getMyNotifications);
router.patch('/:id/read',     markRead);
router.patch('/read-all',     markAllRead);
router.delete('/:id',         deleteNotification);

export default router;
