import { AppError } from '../middleware/errorHandler.js';
import Exam from '../models/Exam.js';
import Result from '../models/Result.js';
import Subscription from '../models/Subscription.js';
import { getSettings } from '../models/SystemSettings.js';
import Transaction from '../models/Transaction.js';
import User from '../models/User.js';
import { log, fromReq } from '../utils/activityLogger.js';
import { sendPlanChangeEmail } from '../services/emailService.js';

export const getStats = async (req, res, next) => {
  try {
    const [userCount, examCount, resultCount, passCount, instructorCount, now] = await Promise.all([
      User.countDocuments(),
      Exam.countDocuments(),
      Result.countDocuments(),
      Result.countDocuments({ passed: true }),
      User.countDocuments({ role: 'instructor' }),
      Promise.resolve(new Date()),
    ]);

    // Users last 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const userGrowth = await User.aggregate([
      { $match: { createdAt: { $gte: sevenDaysAgo } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);

    // Exam attempts last 7 days
    const examActivity = await Result.aggregate([
      { $match: { createdAt: { $gte: sevenDaysAgo } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);

    // Score distribution
    const scoreDistribution = await Result.aggregate([
      {
        $bucket: {
          groupBy: '$percentage',
          boundaries: [0, 25, 50, 75, 90, 101],
          default: 'Other',
          output: { count: { $sum: 1 } },
        },
      },
    ]);

    // Top 5 subjects
    const topSubjects = await Exam.aggregate([
      { $group: { _id: '$subject', count: { $sum: 1 } } },
      { $sort: { count: -1 } }, { $limit: 5 },
    ]);

    res.json({
      users: userCount, instructors: instructorCount, exams: examCount, results: resultCount,
      passRate: resultCount ? Math.round((passCount / resultCount) * 100) : 0,
      userGrowth, examActivity, scoreDistribution, topSubjects,
    });
  } catch (err) { next(err); }
};

export const getUsers = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 20;
    const searchQ = req.query.search
      ? { $or: [{ name: new RegExp(req.query.search, 'i') }, { email: new RegExp(req.query.search, 'i') }] }
      : {};
    const planFilter = req.query.plan ? { plan: req.query.plan } : {};
    const filter = { ...searchQ, ...planFilter };
    const [users, total] = await Promise.all([
      User.find(filter).select('-password -refreshToken').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      User.countDocuments(filter),
    ]);
    // Add planStatus to each user
    const now = new Date();
    const usersWithStatus = users.map(u => {
      const obj = u.toObject({ virtuals: true });
      obj.planStatus = u.plan === 'free' ? 'free' : (u.planExpiresAt && u.planExpiresAt < now ? 'expired' : 'active');
      return obj;
    });
    res.json({ users: usersWithStatus, total, page, pages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
};

export const updateUserRole = async (req, res, next) => {
  try {
    if (!['user', 'instructor', 'admin'].includes(req.body.role)) return next(new AppError('Invalid role', 400));
    const user = await User.findByIdAndUpdate(req.params.id, { role: req.body.role }, { new: true }).select('-password');
    if (!user) return next(new AppError('User not found', 404));
    await log({ user: req.user, action: 'admin_role_changed', category: 'admin', metadata: { targetUserId: req.params.id, newRole: req.body.role }, ...fromReq(req) });
    res.json({ user });
  } catch (err) { next(err); }
};

export const toggleBlockUser = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return next(new AppError('User not found', 404));
    if (user.role === 'admin') return next(new AppError('Cannot block an admin', 400));
    user.isBlocked = !user.isBlocked;
    await user.save({ validateBeforeSave: false });
    const action = user.isBlocked ? 'admin_user_blocked' : 'admin_user_unblocked';
    await log({ user: req.user, action, category: 'admin', metadata: { targetUserId: req.params.id }, ...fromReq(req), severity: 'warning' });
    res.json({ message: `User ${user.isBlocked ? 'blocked' : 'unblocked'}`, isBlocked: user.isBlocked });
  } catch (err) { next(err); }
};

export const deleteUser = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return next(new AppError('User not found', 404));
    if (user.role === 'admin') return next(new AppError('Cannot delete an admin', 400));
    await user.deleteOne();
    await log({ user: req.user, action: 'admin_user_deleted', category: 'admin', metadata: { targetEmail: user.email }, ...fromReq(req), severity: 'warning' });
    res.json({ message: 'User deleted' });
  } catch (err) { next(err); }
};

export const getPublicExams = async (req, res, next) => {
  try {
    const exams = await Exam.find({ isPublic: true }).populate('createdBy', 'name').sort({ createdAt: -1 });
    res.json({ exams });
  } catch (err) { next(err); }
};

export const getAdminTransactions = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 25;
    const [transactions, total] = await Promise.all([
      Transaction.find().populate('user', 'name email').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      Transaction.countDocuments(),
    ]);
    res.json({ transactions, total, page, pages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
};

export const getAdminSubscriptions = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 25;
    const filter = req.query.status ? { status: req.query.status } : {};
    const [subscriptions, total] = await Promise.all([
      Subscription.find(filter).populate('user', 'name email plan planExpiresAt').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      Subscription.countDocuments(filter),
    ]);
    res.json({ subscriptions, total, page, pages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
};

export const updateUserPlan = async (req, res, next) => {
  try {
    const { plan, months = 1 } = req.body;
    if (!['free', 'pro', 'enterprise'].includes(plan)) return next(new AppError('Invalid plan', 400));

    const user = await User.findById(req.params.id);
    if (!user) return next(new AppError('User not found', 404));

    const oldPlan = user.plan;

    user.plan = plan;
    if (plan === 'free') {
      user.planExpiresAt = null;
    } else {
      const expiry = new Date();
      expiry.setMonth(expiry.getMonth() + Number(months));
      user.planExpiresAt = expiry;
    }
    user.examsCreatedThisMonth = 0;
    await user.save({ validateBeforeSave: false });

    const settings = await getSettings();
    const planRanks = { free: 0, pro: 1, enterprise: 2 };
    const isUpgrade = (planRanks[plan] ?? 0) > (planRanks[oldPlan] ?? 0);
    const emailAllowed = isUpgrade ? settings.emailPlanUpgradeEnabled : settings.emailPlanDowngradeEnabled;
    if (emailAllowed) {
      sendPlanChangeEmail({
        email: user.email,
        name: user.name,
        oldPlan,
        newPlan: plan,
        changedBy: 'Admin',
      }).catch(() => {});
    }

    await log({ user: req.user, action: 'admin_plan_changed', category: 'admin', metadata: { targetUserId: req.params.id, plan }, ...fromReq(req) });
    res.json({ message: 'Plan updated', plan: user.plan, planExpiresAt: user.planExpiresAt });
  } catch (err) { next(err); }
};
