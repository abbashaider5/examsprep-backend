import express from 'express';
import multer from 'multer';
import { changePassword, getAnalytics, getProfile, getRecommendation, updateProfile, uploadAvatar } from '../controllers/profileController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, file, cb) => cb(null, /^image\/(png|jpe?g|webp|gif)$/i.test(file.mimetype)),
});

router.get('/public/:userId', protect, (req, res, next) => { req.params.userId = req.params.userId; next(); }, getProfile);
router.use(protect);
router.get('/', getProfile);
router.patch('/', updateProfile);
router.post('/avatar', upload.single('avatar'), uploadAvatar);
router.get('/analytics', getAnalytics);
router.get('/recommendation', getRecommendation);
router.post('/change-password', protect, changePassword);

export default router;
