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

function signPendingLoginToken(userId) {
  return jwt.sign(
    { sub: String(userId), purpose: 'totp_login' },
    process.env.JWT_SECRET,
    { expiresIn: '5m' },
  );
}

export function beginTotpLogin({ user, email, req, res }) {
  const pendingToken = signPendingLoginToken(user._id);
  return res.status(200).json({
    requiresTOTP: true,
    email,
    pendingToken,
    message: 'Enter the 6-digit code from your authenticator app.',
  });
}

export const setupTotp = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select('+totpPendingSecretEncrypted +totpSecretEncrypted');
    if (!user) return next(new AppError('User not found', 404));

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

    const user = await User.findById(req.user._id).select('+totpPendingSecretEncrypted +totpSecretEncrypted');
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

export const disableTotp = async (req, res, next) => {
  try {
    const { code } = req.body;
    if (!code) return next(new AppError('Authenticator code is required', 400));

    const user = await User.findById(req.user._id).select('+totpSecretEncrypted +totpPendingSecretEncrypted');
    if (!user) return next(new AppError('User not found', 404));
    if (!user.totpEnabled) return next(new AppError('Authenticator is not enabled.', 400));

    const secret = decryptTotpSecret(user.totpSecretEncrypted);
    if (!secret) return next(new AppError('Authenticator configuration is invalid. Contact support.', 400));

    const valid = await verifyTotpToken(secret, code);
    if (!valid) return next(new AppError('Invalid verification code.', 400));

    user.totpEnabled = false;
    user.totpSecretEncrypted = '';
    user.totpPendingSecretEncrypted = '';
    await user.save({ validateBeforeSave: false });

    await log({ user, action: 'totp_disabled', category: 'auth', ...fromReq(req) });

    const fresh = await User.findById(user._id);
    res.json({
      message: 'Authenticator app disabled.',
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
    if (payload?.purpose !== 'totp_login' || !payload?.sub) {
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
