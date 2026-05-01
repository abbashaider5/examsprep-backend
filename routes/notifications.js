import express from 'express';
import { deleteNotification, getMyNotifications, getNotificationById, markAllRead, markRead } from '../controllers/notificationController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();
router.use(protect);

router.get('/',               getMyNotifications);
router.get('/:id',            getNotificationById);
router.patch('/read-all',     markAllRead);
router.patch('/:id/read',     markRead);
router.delete('/:id',         deleteNotification);

export default router;
