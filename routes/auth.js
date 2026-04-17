import express from 'express';
import { getMe, login, logout, refreshAccessToken, requestOTP, signup, verifyOTP } from '../controllers/authController.js';
import { protect } from '../middleware/auth.js';
import { authLimiter } from '../middleware/rateLimiter.js';
import { loginValidation, signupValidation, validate } from '../middleware/validation.js';
import { body } from 'express-validator';

const router = express.Router();

const emailNormalizeOpts = { gmail_remove_dots: false, all_lowercase: true };

router.post('/signup', authLimiter, signupValidation, validate, signup);
router.post('/login', authLimiter, loginValidation, validate, login);
router.post('/verify-otp', authLimiter, [
  body('email').isEmail().normalizeEmail(emailNormalizeOpts),
  body('otp').isLength({ min: 6, max: 6 }).isNumeric().withMessage('OTP must be 6 digits'),
  validate,
], verifyOTP);
router.post('/request-otp', authLimiter, [body('email').isEmail().normalizeEmail(emailNormalizeOpts), validate], requestOTP);
router.post('/logout', logout);
router.post('/refresh', refreshAccessToken);
router.get('/me', protect, getMe);

export default router;
