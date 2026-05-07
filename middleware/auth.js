import jwt from 'jsonwebtoken';
import User from '../models/User.js';

export const protect = async (req, res, next) => {
  try {
    const token = req.cookies?.accessToken || req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ message: 'Not authenticated. Please log in.' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const effectiveId = decoded.id;
    const impersonatorId = decoded.imp || null;

    const effectiveUser = await User.findById(effectiveId).select('+refreshToken');
    if (!effectiveUser) return res.status(401).json({ message: 'User no longer exists.' });
    if (effectiveUser.isBlocked) return res.status(403).json({ message: 'Your account has been suspended.' });

    let sessionUser = effectiveUser;
    if (impersonatorId) {
      const impUser = await User.findById(impersonatorId).select('+refreshToken');
      if (!impUser || impUser.isBlocked) {
        return res.status(401).json({ message: 'Session invalid. Please sign in again.' });
      }
      sessionUser = impUser;
    }

    req.user = effectiveUser;
    req.sessionUser = sessionUser;
    req.isImpersonating = Boolean(impersonatorId);
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    res.status(401).json({ message: 'Invalid token' });
  }
};

/** Sets req.user when a valid session exists; otherwise req.user is null (no error). */
export const optionalProtect = async (req, res, next) => {
  req.user = null;
  req.sessionUser = null;
  req.isImpersonating = false;
  try {
    const token = req.cookies?.accessToken || req.headers.authorization?.replace('Bearer ', '');
    if (!token) return next();
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const effectiveId = decoded.id;
    const impersonatorId = decoded.imp || null;
    const effectiveUser = await User.findById(effectiveId).select('_id role isBlocked enterpriseId');
    if (!effectiveUser || effectiveUser.isBlocked) return next();
    let sessionUser = effectiveUser;
    if (impersonatorId) {
      const impUser = await User.findById(impersonatorId).select('_id role isBlocked');
      if (!impUser || impUser.isBlocked) return next();
      sessionUser = impUser;
    }
    req.user = effectiveUser;
    req.sessionUser = sessionUser;
    req.isImpersonating = Boolean(impersonatorId);
    next();
  } catch {
    next();
  }
};

export const requireAdmin = (req, res, next) => {
  if (req.sessionUser?.role !== 'admin') {
    return res.status(403).json({ message: 'Access denied. Admin only.' });
  }
  next();
};

export const requireInstructor = (req, res, next) => {
  if (!['instructor', 'admin'].includes(req.user?.role)) {
    return res.status(403).json({ message: 'Access denied. Instructor or Admin only.' });
  }
  next();
};

/** Platform principals only; blocks when viewing as another user (impersonation). */
export const requirePrincipal = (req, res, next) => {
  if (req.isImpersonating) {
    return res.status(403).json({ message: 'Exit view mode to use this feature.' });
  }
  if (req.sessionUser?.role !== 'principal') {
    return res.status(403).json({ message: 'Access denied. Enterprise admin only.' });
  }
  next();
};

export const signAccessToken = (effectiveUserId, opts = {}) => {
  const payload = { id: effectiveUserId.toString() };
  if (opts.impersonatorId) {
    payload.imp = opts.impersonatorId.toString();
  }
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
};

export const signRefreshToken = (sessionUserId, opts = {}) => {
  const payload = { id: sessionUserId.toString() };
  if (opts.actAs) payload.actAs = opts.actAs.toString();
  return jwt.sign(payload, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  });
};

// Use VERCEL env var as a reliable cross-domain production signal
// (NODE_ENV may stay 'development' if .env file overrides it on Vercel)
export const isProd = () => process.env.NODE_ENV === 'production' || !!process.env.VERCEL;

const cookieOpts = (maxAge) => ({
  httpOnly: true,
  secure: isProd(),
  sameSite: isProd() ? 'none' : 'lax',
  maxAge,
});

/** @param {import('mongoose').Types.ObjectId|string} sessionUserId - logged-in account */
export const setAuthCookies = (res, sessionUserId, opts = {}) => {
  const actAs = opts.actAs || null;
  const effectiveId = actAs || sessionUserId;
  const accessToken = signAccessToken(effectiveId, actAs ? { impersonatorId: sessionUserId } : {});
  const refreshToken = signRefreshToken(sessionUserId, { actAs });
  res.cookie('accessToken', accessToken, cookieOpts(7 * 24 * 60 * 60 * 1000));
  res.cookie('refreshToken', refreshToken, cookieOpts(30 * 24 * 60 * 60 * 1000));
  return { accessToken, refreshToken };
};

export const clearAuthCookies = (res) => {
  const opts = { httpOnly: true, secure: isProd(), sameSite: isProd() ? 'none' : 'lax' };
  res.clearCookie('accessToken', opts);
  res.clearCookie('refreshToken', opts);
};
