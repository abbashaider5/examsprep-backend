import { AppError } from '../middleware/errorHandler.js';
import Exam from '../models/Exam.js';
import Result from '../models/Result.js';
import Plan from '../models/Plan.js';
import Subscription from '../models/Subscription.js';
import { getSettings } from '../models/SystemSettings.js';
import Transaction from '../models/Transaction.js';
import User from '../models/User.js';
import crypto from 'crypto';
import { log, fromReq } from '../utils/activityLogger.js';
import { sendAdminProvisionedAccountEmail, sendPlanChangeEmail } from '../services/emailService.js';
import { getActiveIncidentSummary } from '../services/aiHealthService.js';

export const getStats = async (req, res, next) => {
  try {
    const [userCount, examCount, resultCount, passCount, instructorCount, adminCount, planAgg, now] = await Promise.all([
      User.countDocuments(),
      Exam.countDocuments(),
      Result.countDocuments(),
      Result.countDocuments({ passed: true }),
      User.countDocuments({ role: 'instructor' }),
      User.countDocuments({ role: 'admin' }),
      User.aggregate([{ $group: { _id: '$plan', count: { $sum: 1 } } }]),
      Promise.resolve(new Date()),
    ]);

    const planMap = Object.fromEntries(planAgg.map(p => [p._id, p.count]));
    const plans = {
      free: planMap.free || 0,
      pro: planMap.pro || 0,
      enterprise: planMap.enterprise || 0,
    };

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

    const aiHealth = await getActiveIncidentSummary();

    res.json({
      users: userCount,
      instructors: instructorCount,
      admins: adminCount,
      exams: examCount,
      results: resultCount,
      passRate: resultCount ? Math.round((passCount / resultCount) * 100) : 0,
      plans,
      userGrowth,
      examActivity,
      scoreDistribution,
      topSubjects,
      aiHealth,
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

export const createUser = async (req, res, next) => {
  try {
    const { name, email, password, role = 'user', notifyEmail = true } = req.body;
    if (!name?.trim() || !email?.trim()) return next(new AppError('Name and email are required', 400));
    if (!['user', 'instructor', 'admin', 'principal'].includes(role)) return next(new AppError('Invalid role', 400));

    const normalizedEmail = String(email).toLowerCase().trim();
    const exists = await User.findOne({ email: normalizedEmail });
    if (exists) return next(new AppError('An account with this email already exists', 400));

    const plainPassword = password && String(password).length >= 6
      ? String(password)
      : crypto.randomBytes(12).toString('base64url').slice(0, 16);

    const user = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      password: plainPassword,
      role,
    });

    const sendMail = notifyEmail !== false && notifyEmail !== 'false';
    let emailDelivered = false;
    if (sendMail) {
      emailDelivered = await sendAdminProvisionedAccountEmail({
        email: user.email,
        name: user.name,
        temporaryPassword: plainPassword,
      });
    }

    await log({
      user: req.user,
      action: 'admin_user_created',
      category: 'admin',
      metadata: { targetEmail: user.email, role: user.role },
      ...fromReq(req),
    });

    const safe = user.toObject({ virtuals: true });
    delete safe.password;
    res.status(201).json({
      user: safe,
      notifyEmailSent: sendMail && emailDelivered,
      /** True when the admin asked to email but Resend did not accept the message (see server logs). */
      emailSendFailed: sendMail && !emailDelivered,
      ...(!sendMail || !emailDelivered ? { temporaryPassword: plainPassword } : {}),
    });
  } catch (err) { next(err); }
};

export const updateUserRole = async (req, res, next) => {
  try {
    if (!['user', 'instructor', 'admin', 'principal'].includes(req.body.role)) return next(new AppError('Invalid role', 400));
    const updates = { role: req.body.role };
    if (req.body.role !== 'instructor' && req.body.role !== 'admin') {
      updates.isInstructorVerified = false;
      updates.instructorVerifiedAt = null;
      updates.instructorVerifiedBy = null;
    }
    const user = await User.findByIdAndUpdate(req.params.id, updates, { new: true }).select('-password');
    if (!user) return next(new AppError('User not found', 404));
    await log({ user: req.user, action: 'admin_role_changed', category: 'admin', metadata: { targetUserId: req.params.id, newRole: req.body.role }, ...fromReq(req) });
    res.json({ user });
  } catch (err) { next(err); }
};

export const toggleInstructorVerified = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return next(new AppError('User not found', 404));
    if (user.role !== 'instructor' && user.role !== 'admin') {
      return next(new AppError('Only instructors can be verified', 400));
    }
    const nextVerified = req.body.verified !== undefined
      ? Boolean(req.body.verified)
      : !user.isInstructorVerified;
    user.isInstructorVerified = nextVerified;
    user.instructorVerifiedAt = nextVerified ? new Date() : null;
    user.instructorVerifiedBy = nextVerified ? req.user._id : null;
    await user.save({ validateBeforeSave: false });
    await log({
      user: req.user,
      action: nextVerified ? 'admin_instructor_verified' : 'admin_instructor_unverified',
      category: 'admin',
      metadata: { targetUserId: req.params.id },
      ...fromReq(req),
    });
    const safe = user.toObject({ virtuals: true });
    delete safe.password;
    res.json({
      message: nextVerified ? 'Instructor verified' : 'Instructor verification removed',
      isInstructorVerified: user.isInstructorVerified,
      user: safe,
    });
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
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.autoRenew === 'enabled') filter.autoRenewEnabled = true;
    if (req.query.autoRenew === 'disabled') filter.autoRenewEnabled = { $ne: true };
    if (req.query.problem === 'failed') {
      filter.$or = [
        { status: 'payment_pending' },
        { status: 'grace_period' },
        { subscriptionStatus: 'payment_failed' },
      ];
    }
    const [subscriptions, total] = await Promise.all([
      Subscription.find(filter).populate('user', 'name email plan planExpiresAt').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      Subscription.countDocuments(filter),
    ]);
    const [activeCount, autoRenewEnabledCount, paymentFailedCount, graceUsersCount, cancelledCount] = await Promise.all([
      Subscription.countDocuments({ status: 'active' }),
      Subscription.countDocuments({ autoRenewEnabled: true }),
      Subscription.countDocuments({ subscriptionStatus: 'payment_failed' }),
      Subscription.countDocuments({ gracePeriodEndsAt: { $gt: new Date() } }),
      Subscription.countDocuments({ status: 'cancelled' }),
    ]);
    res.json({
      subscriptions,
      total,
      page,
      pages: Math.ceil(total / limit),
      stats: {
        activeCount,
        autoRenewEnabledCount,
        paymentFailedCount,
        graceUsersCount,
        cancelledCount,
      },
    });
  } catch (err) { next(err); }
};

export const updateUserPlan = async (req, res, next) => {
  try {
    const { plan, months = 1, customExpiryDate } = req.body;
    const requested = String(plan || '').trim().toLowerCase();

    const user = await User.findById(req.params.id);
    if (!user) return next(new AppError('User not found', 404));

    const oldPlan = user.plan;
    const oldPlanCode = user.individualPlanCode || '';
    const oldExpiry = user.planExpiresAt || null;

    let dynamicPlan = null;
    if (requested && requested !== 'free') {
      dynamicPlan = await Plan.findOne({ code: requested, audience: 'individual' }).lean();
      if (!dynamicPlan && !['pro', 'enterprise'].includes(requested)) {
        return next(new AppError('Invalid plan', 400));
      }
    }

    const normalizedMonths = [1, 3, 6, 12].includes(Number(months)) ? Number(months) : 1;
    let computedExpiry = null;
    if (requested !== 'free') {
      if (customExpiryDate) {
        const parsed = new Date(customExpiryDate);
        if (Number.isNaN(parsed.getTime())) return next(new AppError('Invalid custom expiry date.', 400));
        computedExpiry = parsed;
      } else {
        computedExpiry = new Date();
        computedExpiry.setMonth(computedExpiry.getMonth() + normalizedMonths);
      }
    }

    user.plan = requested === 'free' ? 'free' : 'pro';
    if (requested === 'free') {
      user.planExpiresAt = null;
      user.individualPlanCode = '';
      user.extraExamCreditsBalance = 0;
    } else {
      user.planExpiresAt = computedExpiry;
      user.individualPlanCode = dynamicPlan?.code || (requested === 'pro' ? 'premium' : requested);
    }
    user.examsCreatedThisMonth = 0;
    await user.save({ validateBeforeSave: false });

    if (requested === 'free') {
      await Subscription.updateMany(
        { user: user._id, status: { $in: ['active', 'pending', 'payment_pending', 'grace_period'] } },
        { $set: { status: 'expired', autoRenewEnabled: false } },
      );
    } else {
      await Subscription.findOneAndUpdate(
        { user: user._id, status: { $in: ['active', 'pending', 'payment_pending', 'grace_period'] } },
        {
          user: user._id,
          plan: 'pro',
          individualPlanCode: user.individualPlanCode || requested,
          status: 'active',
          subscriptionStatus: 'active',
          autoRenewEnabled: Boolean(user.autoRenew),
          startDate: new Date(),
          endDate: user.planExpiresAt,
          durationMonths: customExpiryDate ? 1 : normalizedMonths,
          billingCycle: 'multi',
          amountPaid: 0,
          provider: 'manual',
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
    }

    const settings = await getSettings();
    const planRanks = { free: 0, pro: 1, enterprise: 2 };
    const newRankKey = requested === 'free' ? 'free' : (requested === 'enterprise' ? 'enterprise' : 'pro');
    const isUpgrade = (planRanks[newRankKey] ?? 0) > (planRanks[oldPlan] ?? 0);
    const emailAllowed = isUpgrade ? settings.emailPlanUpgradeEnabled : settings.emailPlanDowngradeEnabled;
    if (emailAllowed) {
      sendPlanChangeEmail({
        email: user.email,
        name: user.name,
        oldPlan,
        newPlan: requested,
        changedBy: 'Admin',
      }).catch(() => {});
    }

    await log({
      user: req.user,
      action: 'admin_plan_changed',
      category: 'admin',
      metadata: {
        targetUserId: req.params.id,
        oldPlan,
        oldPlanCode,
        oldExpiry,
        requestedPlan: requested,
        newPlanCode: user.individualPlanCode,
        months: customExpiryDate ? null : normalizedMonths,
        customExpiryDate: customExpiryDate || null,
        newExpiry: user.planExpiresAt,
      },
      ...fromReq(req),
    });
    res.json({
      message: 'Plan updated',
      previous: { plan: oldPlan, planCode: oldPlanCode, planExpiresAt: oldExpiry },
      next: { plan: user.plan, planCode: user.individualPlanCode || '', planExpiresAt: user.planExpiresAt },
      subscriptionStatus: user.subscriptionStatus || '',
    });
  } catch (err) { next(err); }
};
