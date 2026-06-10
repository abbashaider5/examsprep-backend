import express from 'express';
import { forgotPassword, getMe, googleAuth, login, logout, refreshAccessToken, requestOTP, resetPassword, signup, verifyOTP, completeAccountOnboarding } from '../controllers/authController.js';
import { confirmTotp, disableTotp, setupTotp, verifyTotpLogin } from '../controllers/totpController.js';
import { protect } from '../middleware/auth.js';
import { authLimiter } from '../middleware/rateLimiter.js';
import { loginValidation, signupValidation, validate } from '../middleware/validation.js';
import { body } from 'express-validator';

const router = express.Router();

const emailNormalizeOpts = { gmail_remove_dots: false, all_lowercase: true };

router.post('/signup', authLimiter, signupValidation, validate, signup);
router.post('/login', authLimiter, loginValidation, validate, login);
router.post('/google', authLimiter, googleAuth);
router.post('/complete-onboarding', protect, authLimiter, [
  body('accountType').isIn(['student', 'instructor']).withMessage('Invalid account type'),
  body('organizationType').optional().isIn(['school', 'institute']).withMessage('Invalid organization type'),
  validate,
], completeAccountOnboarding);
router.post('/verify-otp', authLimiter, [
  body('email').isEmail().normalizeEmail(emailNormalizeOpts),
  body('otp').isLength({ min: 6, max: 6 }).isNumeric().withMessage('OTP must be 6 digits'),
  validate,
], verifyOTP);
router.post('/verify-totp', authLimiter, [
  body('pendingToken').isString().notEmpty(),
  body('code').isLength({ min: 6, max: 6 }).isNumeric().withMessage('Code must be 6 digits'),
  validate,
], verifyTotpLogin);
router.post('/totp/setup', protect, authLimiter, setupTotp);
router.post('/totp/confirm', protect, authLimiter, [
  body('code').isLength({ min: 6, max: 6 }).isNumeric().withMessage('Code must be 6 digits'),
  validate,
], confirmTotp);
router.post('/totp/disable', protect, authLimiter, [
  body('code').isLength({ min: 6, max: 6 }).isNumeric().withMessage('Code must be 6 digits'),
  validate,
], disableTotp);
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
