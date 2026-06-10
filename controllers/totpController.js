import jwt from 'jsonwebtoken';
import { AppError } from '../middleware/errorHandler.js';
import { setAuthCookies } from '../middleware/auth.js';
import User from '../models/User.js';
import {
  buildTotpQrDataUrl,
  createTotpSecret,
  decryptTotpSecret,
  encryptTotpSecret,
  verifyTotpToken,
} from '../services/totpService.js';
import { log, fromReq } from '../utils/activityLogger.js';
import { buildUserResponse } from './authController.js';

export function signPending2FAToken(userId, methods = []) {
  return jwt.sign(
    { sub: String(userId), purpose: 'two_factor_login', methods },
    process.env.JWT_SECRET,
    { expiresIn: '5m' },
  );
}

function signTotpLoginToken(userId) {
  return jwt.sign(
    { sub: String(userId), purpose: 'totp_login' },
    process.env.JWT_SECRET,
    { expiresIn: '5m' },
  );
}

export function begin2FAChoice({ user, email, methods, res }) {
  return res.status(200).json({
    requires2FA: true,
    methods,
    email,
    pendingToken: signPending2FAToken(user._id, methods),
    message: 'Choose a verification method to continue.',
  });
}

export function beginTotpLogin({ user, email, req, res }) {
  const pendingToken = signTotpLoginToken(user._id);
  return res.status(200).json({
    requiresTOTP: true,
    email,
    pendingToken,
    message: 'Enter the 6-digit code from your authenticator app.',
  });
}

function userHasTotpConfigured(user) {
  return !!(user.totpConfigured || user.totpSecretEncrypted);
}

export const setupTotp = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select('+totpPendingSecretEncrypted +totpSecretEncrypted +totpConfigured');
    if (!user) return next(new AppError('User not found', 404));

    if (userHasTotpConfigured(user)) {
      return next(new AppError('Authenticator is already set up. Use the toggle to enable or disable it.', 400));
    }

    const secret = createTotpSecret();
    user.totpPendingSecretEncrypted = encryptTotpSecret(secret);
    await user.save({ validateBeforeSave: false });

    const qrCodeDataUrl = await buildTotpQrDataUrl(user.email, secret);
    res.json({
      secret,
      qrCodeDataUrl,
      message: 'Scan the QR code with your authenticator app, then enter the 6-digit code to confirm.',
    });
  } catch (err) { next(err); }
};

export const confirmTotp = async (req, res, next) => {
  try {
    const { code } = req.body;
    if (!code) return next(new AppError('Verification code is required', 400));

    const user = await User.findById(req.user._id).select('+totpPendingSecretEncrypted +totpSecretEncrypted +totpConfigured');
    if (!user) return next(new AppError('User not found', 404));
    if (!user.totpPendingSecretEncrypted) {
      return next(new AppError('Start setup again to generate a new QR code.', 400));
    }

    const pendingSecret = decryptTotpSecret(user.totpPendingSecretEncrypted);
    if (!pendingSecret) return next(new AppError('Setup expired. Please generate a new QR code.', 400));

    const valid = await verifyTotpToken(pendingSecret, code);
    if (!valid) return next(new AppError('Invalid verification code.', 400));

    user.totpSecretEncrypted = user.totpPendingSecretEncrypted;
    user.totpPendingSecretEncrypted = '';
    user.totpConfigured = true;
    user.totpEnabled = true;
    await user.save({ validateBeforeSave: false });

    await log({ user, action: 'totp_enabled', category: 'auth', ...fromReq(req) });

    const fresh = await User.findById(user._id);
    res.json({
      message: 'Authenticator app enabled.',
      user: await buildUserResponse(fresh, {}),
    });
  } catch (err) { next(err); }
};

export const toggleTotp = async (req, res, next) => {
  try {
    const enabled = !!req.body.enabled;
    const user = await User.findById(req.user._id).select('+totpSecretEncrypted +totpConfigured');
    if (!user) return next(new AppError('User not found', 404));

    if (user.totpSecretEncrypted && !user.totpConfigured) {
      user.totpConfigured = true;
    }

    if (enabled) {
      if (!userHasTotpConfigured(user) || !user.totpSecretEncrypted) {
        return next(new AppError('Set up your authenticator app before enabling it.', 400));
      }
      user.totpEnabled = true;
    } else {
      user.totpEnabled = false;
    }
    await user.save({ validateBeforeSave: false });

    await log({
      user,
      action: enabled ? 'totp_enabled' : 'totp_disabled',
      category: 'auth',
      ...fromReq(req),
    });

    const fresh = await User.findById(user._id);
    res.json({
      message: enabled ? 'Authenticator app enabled for login.' : 'Authenticator app disabled for login.',
      user: await buildUserResponse(fresh, {}),
    });
  } catch (err) { next(err); }
};

export const verifyTotpLogin = async (req, res, next) => {
  try {
    const { pendingToken, code } = req.body;
    if (!pendingToken || !code) {
      return next(new AppError('Authenticator code is required', 400));
    }

    let payload;
    try {
      payload = jwt.verify(pendingToken, process.env.JWT_SECRET);
    } catch {
      return next(new AppError('Login session expired. Please sign in again.', 401));
    }
    const validPurpose = payload?.purpose === 'totp_login' || payload?.purpose === 'two_factor_login';
    if (!validPurpose || !payload?.sub) {
      return next(new AppError('Invalid login session', 401));
    }

    const user = await User.findById(payload.sub).select('+totpSecretEncrypted +refreshToken');
    if (!user || !user.totpEnabled) {
      return next(new AppError('Authenticator is not enabled for this account.', 400));
    }

    const secret = decryptTotpSecret(user.totpSecretEncrypted);
    const valid = await verifyTotpToken(secret, code);
    if (!valid) return next(new AppError('Invalid verification code.', 400));

    const { accessToken, refreshToken } = setAuthCookies(res, user._id);
    await User.findByIdAndUpdate(user._id, { refreshToken });

    await log({ user, action: 'login_totp_verified', category: 'auth', ...fromReq(req) });

    res.json({
      message: 'Login successful',
      user: await buildUserResponse(user, {}),
      accessToken,
    });
  } catch (err) { next(err); }
};
