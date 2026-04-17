import ActivityLog from '../models/ActivityLog.js';

export const getLogs = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 30;
    const skip = (page - 1) * limit;
    const filter = {};

    if (req.query.category) filter.category = req.query.category;
    if (req.query.action) filter.action = req.query.action;
    if (req.query.severity) filter.severity = req.query.severity;
    if (req.query.userId) filter.user = req.query.userId;
    if (req.query.from || req.query.to) {
      filter.createdAt = {};
      if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
      if (req.query.to) filter.createdAt.$lte = new Date(req.query.to);
    }

    const [logs, total] = await Promise.all([
      ActivityLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('user', 'name email'),
      ActivityLog.countDocuments(filter),
    ]);

    res.json({ logs, total, page, pages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
};

export const getLogStats = async (req, res, next) => {
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [byAction, byCategory, bySeverity, recentLogins, examActivity] = await Promise.all([
      ActivityLog.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: '$action', count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 10 }]),
      ActivityLog.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: '$category', count: { $sum: 1 } } }]),
      ActivityLog.aggregate([{ $group: { _id: '$severity', count: { $sum: 1 } } }]),
      ActivityLog.countDocuments({ action: 'login', createdAt: { $gte: since } }),
      ActivityLog.countDocuments({ category: 'exam', createdAt: { $gte: since } }),
    ]);

    // Daily logins last 7 days
    const dailyLogins = await ActivityLog.aggregate([
      { $match: { action: 'login', createdAt: { $gte: since } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);

    res.json({ byAction, byCategory, bySeverity, recentLogins, examActivity, dailyLogins });
  } catch (err) { next(err); }
};

export const clearOldLogs = async (req, res, next) => {
  try {
    const days = parseInt(req.body?.days || req.query.days) || 30;
    const before = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const result = await ActivityLog.deleteMany({ createdAt: { $lt: before } });
    res.json({ deleted: result.deletedCount, message: `Deleted logs older than ${days} days` });
  } catch (err) { next(err); }
};
