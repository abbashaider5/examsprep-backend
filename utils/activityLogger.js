import ActivityLog from '../models/ActivityLog.js';
import logger from '../utils/logger.js';

export const log = async ({
  user = null,
  email = '',
  name = '',
  action,
  category,
  metadata = {},
  ip = '',
  userAgent = '',
  severity = 'info',
}) => {
  try {
    await ActivityLog.create({
      user: user?._id || user || null,
      userEmail: email || user?.email || '',
      userName: name || user?.name || '',
      action,
      category,
      metadata,
      ip,
      userAgent,
      severity,
    });
  } catch (err) {
    logger.error('ActivityLog write failed:', err.message);
  }
};

export const fromReq = (req) => ({
  ip: req.ip || req.headers['x-forwarded-for'] || '',
  userAgent: req.headers['user-agent'] || '',
});
