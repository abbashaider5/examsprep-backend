import express from 'express';
import {
    adminCreate,
    adminDelete,
    adminGetAll,
    adminToggle,
    adminUpdate,
    dismiss,
    getAnnouncements, markRead,
} from '../controllers/announcementController.js';
import { protect, requireAdmin } from '../middleware/auth.js';

const router = express.Router();

// All routes require authentication
router.use(protect);

// ── User-facing ───────────────────────────────────────────────────────────────
router.get('/',             getAnnouncements);
router.post('/:id/read',    markRead);
router.post('/:id/dismiss', dismiss);

// ── Admin-only ────────────────────────────────────────────────────────────────
router.get('/admin',              requireAdmin, adminGetAll);
router.post('/admin',             requireAdmin, adminCreate);
router.put('/admin/:id',          requireAdmin, adminUpdate);
router.delete('/admin/:id',       requireAdmin, adminDelete);
router.patch('/admin/:id/toggle', requireAdmin, adminToggle);

export default router;
