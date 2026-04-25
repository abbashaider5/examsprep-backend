import express from 'express';
import { forgotPassword, getMe, login, logout, refreshAccessToken, requestOTP, resetPassword, signup, verifyOTP } from '../controllers/authController.js';
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
router.post('/forgot-password', authLimiter, [
  body('email').isEmail().normalizeEmail(emailNormalizeOpts).withMessage('Enter a valid email'),
  validate,
], forgotPassword);
router.post('/reset-password', authLimiter, [
  body('email').isEmail().normalizeEmail(emailNormalizeOpts).withMessage('Enter a valid email'),
  body('otp').isLength({ min: 6, max: 6 }).isNumeric().withMessage('OTP must be 6 digits'),
  body('newPassword').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  validate,
], resetPassword);
router.post('/logout', logout);
router.post('/refresh', refreshAccessToken);
router.get('/me', protect, getMe);

export default router;
