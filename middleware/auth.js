import jwt from 'jsonwebtoken';
import User from '../models/User.js';

export const protect = async (req, res, next) => {
  try {
    const token = req.cookies?.accessToken || req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ message: 'Not authenticated. Please log in.' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('+refreshToken');
    if (!user) return res.status(401).json({ message: 'User no longer exists.' });
    if (user.isBlocked) return res.status(403).json({ message: 'Your account has been suspended.' });

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    res.status(401).json({ message: 'Invalid token' });
  }
};

export const requireAdmin = (req, res, next) => {
  if (req.user?.role !== 'admin') {
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

export const signAccessToken = (userId) => {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
  });
};

export const signRefreshToken = (userId) => {
  return jwt.sign({ id: userId }, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
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

export const setAuthCookies = (res, userId) => {
  const accessToken = signAccessToken(userId);
  const refreshToken = signRefreshToken(userId);
  res.cookie('accessToken', accessToken, cookieOpts(15 * 60 * 1000));
  res.cookie('refreshToken', refreshToken, cookieOpts(7 * 24 * 60 * 60 * 1000));
  return { accessToken, refreshToken };
};

export const clearAuthCookies = (res) => {
  const opts = { httpOnly: true, secure: isProd(), sameSite: isProd() ? 'none' : 'lax' };
  res.clearCookie('accessToken', opts);
  res.clearCookie('refreshToken', opts);
};
