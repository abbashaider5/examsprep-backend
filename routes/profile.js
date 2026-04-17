import express from 'express';
import { changePassword, getAnalytics, getProfile, getRecommendation, updateProfile } from '../controllers/profileController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

router.get('/public/:userId', protect, (req, res, next) => { req.params.userId = req.params.userId; next(); }, getProfile);
router.use(protect);
router.get('/', getProfile);
router.patch('/', updateProfile);
router.get('/analytics', getAnalytics);
router.get('/recommendation', getRecommendation);
router.post('/change-password', protect, changePassword);

export default router;
