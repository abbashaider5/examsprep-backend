import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { setAuthCookies, clearAuthCookies, signAccessToken, isProd } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import User from '../models/User.js';
import OTPCode from '../models/OTPCode.js';
import { getSettings } from '../models/SystemSettings.js';
import { sendWelcomeEmail, sendOTPEmail, sendSecurityAlertEmail, sendPasswordResetEmail } from '../services/emailService.js';
import { verifyRecaptchaToken } from '../services/recaptchaService.js';
import { log, fromReq } from '../utils/activityLogger.js';
import logger from '../utils/logger.js';

const googleClient = process.env.GOOGLE_CLIENT_ID
  ? new OAuth2Client(process.env.GOOGLE_CLIENT_ID)
  : null;

const shouldRequireTwoFactor = (user, settings) =>
  !!(settings?.emailOtpEnabled && (user?.twoFactorEnabled || (settings?.twoFactorAuthEnabled && settings?.twoFactorRequired)));

const beginTwoFactorLogin = async ({ user, email, settings, req, res }) => {
  if (!settings.emailOtpEnabled) {
    return res.status(503).json({ message: 'Email OTP is currently disabled. Please contact admin.' });
  }
  const otpRecord = await OTPCode.generate(email, 'login');
  const sent = await sendOTPEmail({ email, name: user.name, otp: otpRecord.otp, purpose: 'login' });
  if (!sent) {
    return res.status(503).json({ message: 'Unable to send OTP email right now. Please try again later.' });
  }
  await log({ user, action: 'otp_requested', category: 'auth', ...fromReq(req) });
  return res.status(200).json({ requiresOTP: true, email, message: 'An OTP has been sent to your email.' });
};

// ── Signup ────────────────────────────────────────────────────────────────────
export const signup = async (req, res, next) => {
  try {
    await verifyRecaptchaToken(req.body?.recaptchaToken);
    const settings = await getSettings();
    if (!settings.allowNewRegistrations) {
      return next(new AppError('New registrations are currently disabled.', 403));
    }

    const { name, email, password } = req.body;
    const existing = await User.findOne({ email });
    if (existing) return next(new AppError('An account with this email already exists.', 409));

    const user = await User.create({ name, email, password });

    await log({ user, action: 'signup', category: 'auth', ...fromReq(req) });

    if (settings.twoFactorAuthEnabled) {
      const otp = await OTPCode.generate(email, 'signup');
      if (settings.emailOtpEnabled) {
        sendOTPEmail({ email, name, otp: otp.otp, purpose: 'signup' }).catch(logger.error);
      }
      return res.status(200).json({ requiresOTP: true, email, message: 'Verify your email to complete signup.' });
    }

    const { refreshToken } = setAuthCookies(res, user._id);
    await User.findByIdAndUpdate(user._id, { refreshToken });

    if (settings.emailWelcomeEnabled) {
      sendWelcomeEmail({ email, name }).catch(logger.error);
    }

    res.status(201).json({ message: 'Account created successfully', user: sanitizeUser(user) });
  } catch (err) { next(err); }
};

// ── Verify OTP (completes signup or login) ────────────────────────────────────
export const verifyOTP = async (req, res, next) => {
  try {
    const { email, otp, purpose = 'login' } = req.body;
    if (!email || !otp) return next(new AppError('Email and OTP are required', 400));

    const result = await OTPCode.verify(email, otp, purpose);
    if (!result.valid) {
      await log({ email, action: 'otp_failed', category: 'auth', metadata: { purpose }, ...fromReq(req), severity: 'warning' });
      return next(new AppError(result.reason, 400));
    }

    let user = await User.findOne({ email });
    if (purpose === 'signup' && !user) {
      return next(new AppError('User not found. Please sign up again.', 404));
    }
    if (!user) return next(new AppError('User not found.', 404));

    if (purpose === 'signup') {
      const settings = await getSettings();
      if (settings.emailWelcomeEnabled) {
        sendWelcomeEmail({ email, name: user.name }).catch(logger.error);
      }
    }

    const { refreshToken } = setAuthCookies(res, user._id);
    await User.findByIdAndUpdate(user._id, { refreshToken });

    await log({ user, action: 'otp_verified', category: 'auth', metadata: { purpose }, ...fromReq(req) });
    res.json({ message: 'Verified successfully', user: sanitizeUser(user) });
  } catch (err) { next(err); }
};

// ── Login ─────────────────────────────────────────────────────────────────────
export const login = async (req, res, next) => {
  try {
    await verifyRecaptchaToken(req.body?.recaptchaToken);
    const { email, password } = req.body;
    const settings = await getSettings();

    if (settings.maintenanceMode) {
      return next(new AppError(settings.maintenanceMessage, 503));
    }

    const user = await User.findOne({ email }).select('+password +refreshToken +failedLoginAttempts +accountLockedUntil');
    if (!user) {
      await log({ email, action: 'login_failed', category: 'auth', severity: 'warning', ...fromReq(req) });
      return next(new AppError('Invalid email or password.', 401));
    }

    if (user.isBlocked) return next(new AppError('Your account has been suspended. Contact support.', 403));
    if (user.isAccountLocked()) {
      const mins = Math.ceil((user.accountLockedUntil - Date.now()) / 60000);
      await log({ user, action: 'account_locked', category: 'auth', severity: 'critical', ...fromReq(req) });
      return next(new AppError(`Account locked. Try again in ${mins} minute(s).`, 423));
    }

    const valid = await user.comparePassword(password);
    if (!valid) {
      await user.recordFailedLogin();
      const remaining = settings.maxLoginAttempts - user.failedLoginAttempts;
      await log({ user, action: 'login_failed', category: 'auth', severity: 'warning', metadata: { remaining }, ...fromReq(req) });
      return next(new AppError(`Invalid email or password. ${remaining > 0 ? `${remaining} attempt(s) left.` : 'Account locked for 30 minutes.'}`, 401));
    }

    await user.resetFailedLogins();

    if (shouldRequireTwoFactor(user, settings)) {
      return beginTwoFactorLogin({ user, email, settings, req, res });
    }

    const { refreshToken } = setAuthCookies(res, user._id);
    await User.findByIdAndUpdate(user._id, { refreshToken });

    await log({ user, action: 'login', category: 'auth', ...fromReq(req) });
    res.json({ message: 'Login successful', user: sanitizeUser(user) });
  } catch (err) { next(err); }
};

export const googleAuth = async (req, res, next) => {
  try {
    const { credential, role } = req.body;
    if (!credential) return next(new AppError('Google credential is required.', 400));
    if (!googleClient || !process.env.GOOGLE_CLIENT_ID) {
      return next(new AppError('Google sign-in is not configured on the server.', 503));
    }

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const email = payload?.email?.toLowerCase?.();

    if (!payload || !email || !payload.email_verified) {
      return next(new AppError('Unable to verify your Google account.', 401));
    }

    const settings = await getSettings();
    if (settings.maintenanceMode) {
      return next(new AppError(settings.maintenanceMessage, 503));
    }

    let user = await User.findOne({ email }).select('+refreshToken +failedLoginAttempts +accountLockedUntil');
    const isNewUser = !user;

    if (!user) {
      if (!settings.allowNewRegistrations) {
        return next(new AppError('New registrations are currently disabled.', 403));
      }
      user = await User.create({
        name: payload.name || email.split('@')[0],
        email,
        password: crypto.randomBytes(24).toString('hex'),
        role: role === 'instructor' ? 'instructor' : 'user',
        avatar: payload.picture || '',
        googleId: payload.sub,
        authProvider: 'google',
      });
      await log({ user, action: 'signup_google', category: 'auth', ...fromReq(req) });
      if (settings.emailWelcomeEnabled) {
        sendWelcomeEmail({ email, name: user.name }).catch(logger.error);
      }
    } else {
      if (user.isBlocked) return next(new AppError('Your account has been suspended. Contact support.', 403));
      user.googleId = user.googleId || payload.sub;
      user.authProvider = user.authProvider || 'google';
      if (!user.avatar && payload.picture) user.avatar = payload.picture;
      await user.save({ validateBeforeSave: false });
    }

    if (shouldRequireTwoFactor(user, settings)) {
      return beginTwoFactorLogin({ user, email, settings, req, res });
    }

    const { refreshToken } = setAuthCookies(res, user._id);
    await User.findByIdAndUpdate(user._id, { refreshToken });

    await log({
      user,
      action: isNewUser ? 'login_google_after_signup' : 'login_google',
      category: 'auth',
      ...fromReq(req),
    });
    res.json({
      message: isNewUser ? 'Account created with Google' : 'Signed in with Google',
      user: sanitizeUser(user),
    });
  } catch (err) {
    next(new AppError('Google sign-in failed. Please try again.', 401));
  }
};

// ── Refresh ───────────────────────────────────────────────────────────────────
export const refreshAccessToken = async (req, res, next) => {
  try {
    const token = req.cookies?.refreshToken;
    if (!token) return next(new AppError('No refresh token', 401));

    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    const user = await User.findById(decoded.id).select('+refreshToken');
    if (!user || user.refreshToken !== token) {
      return next(new AppError('Invalid refresh token', 401));
    }

    const accessToken = signAccessToken(user._id);
    res.cookie('accessToken', accessToken, {
      httpOnly: true, secure: isProd(),
      sameSite: isProd() ? 'none' : 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.json({ message: 'Token refreshed' });
  } catch (err) {
    next(new AppError('Invalid or expired refresh token', 401));
  }
};

// ── Logout ────────────────────────────────────────────────────────────────────
export const logout = async (req, res) => {
  const token = req.cookies?.refreshToken;
  if (token) {
    const decoded = jwt.decode(token);
    if (decoded?.id) {
      const user = await User.findById(decoded.id);
      if (user) {
        await User.findByIdAndUpdate(decoded.id, { refreshToken: null });
        await log({ user, action: 'logout', category: 'auth' });
      }
    }
  }
  clearAuthCookies(res);
  res.json({ message: 'Logged out successfully' });
};

// ── Get Me ────────────────────────────────────────────────────────────────────
export const getMe = (req, res) => {
  res.json({ user: sanitizeUser(req.user) });
};

// ── Forgot Password (request OTP) ─────────────────────────────────────────────
export const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });
    if (!user) {
      return next(new AppError('No account was found with this email address. Please check and try again.', 404));
    }
    if (user.isBlocked) {
      return next(new AppError('This account is currently suspended. Please contact support.', 403));
    }

    const otpRecord = await OTPCode.generate(email, 'password_reset');
    const sent = await sendPasswordResetEmail({ email, name: user.name, otp: otpRecord.otp });
    if (!sent) {
      return next(new AppError('Unable to send reset code right now. Please try again later.', 503));
    }
    await log({ user, action: 'password_reset_requested', category: 'auth', ...fromReq(req) });
    res.json({ message: 'A reset code has been sent to your email address.' });
  } catch (err) { next(err); }
};

// ── Reset Password (verify OTP + set new password) ────────────────────────────
export const resetPassword = async (req, res, next) => {
  try {
    const { email, otp, newPassword } = req.body;

    const result = await OTPCode.verify(email, otp, 'password_reset');
    if (!result.valid) {
      return next(new AppError(result.reason, 400));
    }

    const user = await User.findOne({ email }).select('+password');
    if (!user) return next(new AppError('User not found.', 404));

    user.password = newPassword;
    user.failedLoginAttempts = 0;
    user.accountLockedUntil = undefined;
    await user.save();

    // Invalidate all existing sessions
    await User.findByIdAndUpdate(user._id, { refreshToken: null });

    sendSecurityAlertEmail({
      email, name: user.name,
      event: 'Password Reset',
      details: 'Your password was successfully reset via the forgot password flow.',
    }).catch(logger.error);
    await log({ user, action: 'password_reset', category: 'auth', ...fromReq(req) });

    res.json({ message: 'Password updated successfully. Please sign in with your new password.' });
  } catch (err) { next(err); }
};

// ── Send OTP (standalone) ─────────────────────────────────────────────────────
export const requestOTP = async (req, res, next) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });
    if (!user) return next(new AppError('User not found', 404));

    const settings = await getSettings();
    if (!settings.emailOtpEnabled) {
      return next(new AppError('Email OTP is currently disabled. Please contact admin.', 503));
    }

    const otpRecord = await OTPCode.generate(email, 'login');
    const sent = await sendOTPEmail({ email, name: user.name, otp: otpRecord.otp, purpose: 'login' });
    if (!sent) {
      return next(new AppError('Unable to send OTP email right now. Please try again later.', 503));
    }
    await log({ user, action: 'otp_requested', category: 'auth', ...fromReq(req) });
    res.json({ message: 'OTP sent to your email address.' });
  } catch (err) { next(err); }
};

// ── Sanitize ──────────────────────────────────────────────────────────────────
const sanitizeUser = (user) => ({
  id: user._id,
  name: user.name,
  email: user.email,
  role: user.role,
  isInstructor: ['instructor', 'admin'].includes(user.role),
  xp: user.xp,
  level: user.level,
  streak: user.streak,
  badges: user.badges,
  totalExams: user.totalExams,
  avatar: user.avatar,
  authProvider: user.authProvider || 'local',
  twoFactorEnabled: !!user.twoFactorEnabled,
  isPublic: user.isPublic,
  plan: user.getEffectivePlan ? user.getEffectivePlan() : (user.plan || 'free'),
  planExpiresAt: user.planExpiresAt || null,
  planStatus: user.plan === 'free' ? 'free' : (user.planExpiresAt && user.planExpiresAt < new Date() ? 'expired' : 'active'),
  remaining: user.getRemainingExams ? user.getRemainingExams() : null,
  monthlyLimit: user.getMonthlyLimit ? user.getMonthlyLimit() : 3,
});
