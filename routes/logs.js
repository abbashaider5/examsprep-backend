import express from 'express';
import { clearOldLogs, getLogs, getLogStats } from '../controllers/logsController.js';
import { protect, requireAdmin } from '../middleware/auth.js';

const router = express.Router();

router.use(protect, requireAdmin);
router.get('/', getLogs);
router.get('/stats', getLogStats);
router.delete('/clear', clearOldLogs);

export default router;
