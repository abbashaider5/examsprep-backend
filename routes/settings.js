import express from 'express';
import { getPublicSettings, getSystemSettings, updateSystemSettings } from '../controllers/settingsController.js';
import { protect, requireAdmin } from '../middleware/auth.js';

const router = express.Router();

router.get('/public', getPublicSettings);
router.use(protect);
router.get('/', requireAdmin, getSystemSettings);
router.patch('/', requireAdmin, updateSystemSettings);

export default router;
