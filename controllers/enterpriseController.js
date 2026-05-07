import crypto from 'crypto';
import { AppError } from '../middleware/errorHandler.js';
import { setAuthCookies } from '../middleware/auth.js';
import Enterprise from '../models/Enterprise.js';
import EnterpriseTeacherInvite from '../models/EnterpriseTeacherInvite.js';
import SchoolClass from '../models/SchoolClass.js';
import { getSettings } from '../models/SystemSettings.js';
import User from '../models/User.js';
import ActivityLog from '../models/ActivityLog.js';
import { log, fromReq } from '../utils/activityLogger.js';
import { sendEnterprisePrincipalWelcomeEmail, sendEnterpriseTeacherInviteEmail } from '../services/emailService.js';

async function teacherUsageCount(enterpriseId) {
  const [instructors, pending] = await Promise.all([
    User.countDocuments({ enterpriseId, role: 'instructor' }),
    EnterpriseTeacherInvite.countDocuments({ enterprise: enterpriseId, status: 'pending' }),
  ]);
  return instructors + pending;
}

async function computeEnterpriseMonthlyCost({
  teacherLimit,
  examsPerTeacherLimit,
  questionsPerExamLimit,
  aiProctoringEnabled,
}) {
  const s = await getSettings();
  const perTeacher = Number(s.enterpriseCostPerTeacher) || 0;
  const perExam = Number(s.enterpriseCostPerExam) || 0;
  const perQuestion = Number(s.enterpriseCostPerQuestion) || 0;
  const proctorCost = Number(s.enterpriseCostAiProctoring) || 0;
  const teachers = Number(teacherLimit) || 0;
  const exams = Number(examsPerTeacherLimit) || 0;
  const questions = Number(questionsPerExamLimit) || 0;
  return (teachers * perTeacher) + (teachers * exams * perExam) + (teachers * exams * questions * perQuestion) + (aiProctoringEnabled ? proctorCost : 0);
}

// ── Admin ───────────────────────────────────────────────────────────────────

export const adminListEnterprises = async (req, res, next) => {
  try {
    const list = await Enterprise.find()
      .populate('principalUser', 'name email')
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 })
      .lean();
    const withUsage = await Promise.all(list.map(async (e) => {
      const used = await teacherUsageCount(e._id);
      return {
        ...e,
        teacherUsed: used,
        teacherLimit: e.teacherLimit,
        examsPerTeacherLimit: e.examsPerTeacherLimit,
        questionsPerExamLimit: e.questionsPerExamLimit,
        aiProctoringEnabled: e.aiProctoringEnabled !== false,
        estimatedMonthlyCost: e.estimatedMonthlyCost || 0,
      };
    }));
    res.json({ enterprises: withUsage });
  } catch (err) { next(err); }
};

export const adminCreateEnterprise = async (req, res, next) => {
  try {
    const {
      name,
      contactEmail,
      phone = '',
      address = {},
      mode,
      teacherLimit = 5,
      examsPerTeacherLimit = 30,
      questionsPerExamLimit = 100,
      aiProctoringEnabled = true,
      principalName,
      principalEmail,
    } = req.body;

    if (!name?.trim()) return next(new AppError('Enterprise name is required', 400));
    if (!contactEmail?.trim()) return next(new AppError('Contact email is required', 400));
    if (!['school', 'institute'].includes(mode)) return next(new AppError('Mode must be school or institute', 400));
    if (!principalName?.trim() || !principalEmail?.trim()) {
      return next(new AppError('Principal name and email are required', 400));
    }

    const lim = Math.max(1, Math.min(500, Number(teacherLimit) || 5));
    const examLim = Math.max(1, Math.min(500, Number(examsPerTeacherLimit) || 30));
    const qLim = Math.max(5, Math.min(500, Number(questionsPerExamLimit) || 100));
    const pEmail = principalEmail.toLowerCase().trim();
    const aiEnabled = aiProctoringEnabled !== false;
    const estimatedMonthlyCost = await computeEnterpriseMonthlyCost({
      teacherLimit: lim,
      examsPerTeacherLimit: examLim,
      questionsPerExamLimit: qLim,
      aiProctoringEnabled: aiEnabled,
    });

    let principal = await User.findOne({ email: pEmail });
    let temporaryPassword = null;
    if (principal) {
      if (principal.role === 'admin') return next(new AppError('Cannot assign a platform admin as enterprise principal', 400));
      if (principal.enterpriseId && principal.role === 'principal') {
        return next(new AppError('This user is already a principal of another organization', 409));
      }
      if (principal.enterpriseId && principal.role === 'instructor') {
        return next(new AppError('This user already belongs to an enterprise', 409));
      }
    } else {
      temporaryPassword = crypto.randomBytes(14).toString('hex');
      principal = await User.create({
        name: principalName.trim(),
        email: pEmail,
        password: temporaryPassword,
        role: 'principal',
        plan: 'enterprise',
      });
    }

    const enterprise = await Enterprise.create({
      name: name.trim(),
      contactEmail: contactEmail.toLowerCase().trim(),
      phone: String(phone || '').trim(),
      address: {
        country: address.country || '',
        state: address.state || '',
        city: address.city || '',
        zipCode: address.zipCode || '',
      },
      mode,
      teacherLimit: lim,
      examsPerTeacherLimit: examLim,
      questionsPerExamLimit: qLim,
      aiProctoringEnabled: aiEnabled,
      estimatedMonthlyCost,
      principalUser: principal._id,
      createdBy: req.user._id,
    });

    principal.role = 'principal';
    principal.enterpriseId = enterprise._id;
    if (principal.plan === 'free') principal.plan = 'enterprise';
    await principal.save({ validateBeforeSave: false });

    await log({
      user: req.user,
      action: 'enterprise_created',
      category: 'enterprise',
      enterprise: enterprise._id,
      metadata: { enterpriseName: enterprise.name, mode, principalEmail: pEmail },
      ...fromReq(req),
    });

    sendEnterprisePrincipalWelcomeEmail({
      email: principal.email,
      name: principal.name,
      enterpriseName: enterprise.name,
      isNewAccount: Boolean(temporaryPassword),
      temporaryPassword,
    }).catch(() => {});

    const populated = await Enterprise.findById(enterprise._id)
      .populate('principalUser', 'name email')
      .lean();

    res.status(201).json({
      enterprise: {
        ...populated,
        teacherUsed: 0,
        teacherLimit: lim,
        examsPerTeacherLimit: examLim,
        questionsPerExamLimit: qLim,
        aiProctoringEnabled: aiEnabled,
        estimatedMonthlyCost,
      },
    });
  } catch (err) { next(err); }
};

export const adminUpdateEnterpriseTeacherLimit = async (req, res, next) => {
  try {
    const ent = await Enterprise.findById(req.params.id);
    if (!ent) return next(new AppError('Enterprise not found', 404));
    const lim = Math.max(1, Math.min(500, Number(req.body.teacherLimit) || 5));
    const used = await teacherUsageCount(ent._id);
    if (lim < used) {
      return next(new AppError(`Limit cannot be below current usage (${used})`, 400));
    }
    ent.teacherLimit = lim;
    await ent.save();
    res.json({ enterprise: ent });
  } catch (err) { next(err); }
};

export const adminUpdateEnterprise = async (req, res, next) => {
  try {
    const ent = await Enterprise.findById(req.params.id);
    if (!ent) return next(new AppError('Enterprise not found', 404));

    const nextTeacherLimit = req.body.teacherLimit !== undefined
      ? Math.max(1, Math.min(500, Number(req.body.teacherLimit) || ent.teacherLimit))
      : ent.teacherLimit;
    const used = await teacherUsageCount(ent._id);
    if (nextTeacherLimit < used) {
      return next(new AppError(`Teacher limit cannot be below current usage (${used})`, 400));
    }

    if (req.body.name !== undefined) ent.name = String(req.body.name || '').trim() || ent.name;
    if (req.body.contactEmail !== undefined) ent.contactEmail = String(req.body.contactEmail || '').trim().toLowerCase() || ent.contactEmail;
    if (req.body.phone !== undefined) ent.phone = String(req.body.phone || '').trim();
    if (req.body.address && typeof req.body.address === 'object') {
      ent.address = {
        country: req.body.address.country ?? ent.address?.country ?? '',
        state: req.body.address.state ?? ent.address?.state ?? '',
        city: req.body.address.city ?? ent.address?.city ?? '',
        zipCode: req.body.address.zipCode ?? ent.address?.zipCode ?? '',
      };
    }
    // Mode is immutable by design - ignore if present in payload.
    ent.teacherLimit = nextTeacherLimit;
    if (req.body.examsPerTeacherLimit !== undefined) ent.examsPerTeacherLimit = Math.max(1, Math.min(500, Number(req.body.examsPerTeacherLimit) || ent.examsPerTeacherLimit));
    if (req.body.questionsPerExamLimit !== undefined) ent.questionsPerExamLimit = Math.max(5, Math.min(500, Number(req.body.questionsPerExamLimit) || ent.questionsPerExamLimit));
    if (req.body.aiProctoringEnabled !== undefined) ent.aiProctoringEnabled = req.body.aiProctoringEnabled !== false;

    ent.estimatedMonthlyCost = await computeEnterpriseMonthlyCost({
      teacherLimit: ent.teacherLimit,
      examsPerTeacherLimit: ent.examsPerTeacherLimit,
      questionsPerExamLimit: ent.questionsPerExamLimit,
      aiProctoringEnabled: ent.aiProctoringEnabled,
    });

    await ent.save();
    res.json({ enterprise: ent });
  } catch (err) { next(err); }
};

export const adminDeleteEnterprise = async (req, res, next) => {
  try {
    const ent = await Enterprise.findById(req.params.id);
    if (!ent) return next(new AppError('Enterprise not found', 404));

    await User.updateMany(
      { enterpriseId: ent._id, role: 'instructor' },
      {
        $set: {
          enterpriseId: null,
          plan: 'free',
          planExpiresAt: null,
          autoRenew: false,
          schoolClassId: null,
          examsCreatedThisMonth: 0,
        },
      },
    );

    await User.updateOne(
      { _id: ent.principalUser },
      { $set: { enterpriseId: null, role: 'instructor', plan: 'free', planExpiresAt: null, autoRenew: false } },
    );

    await EnterpriseTeacherInvite.updateMany({ enterprise: ent._id, status: 'pending' }, { status: 'cancelled' });
    await SchoolClass.deleteMany({ enterprise: ent._id });
    await ent.deleteOne();

    res.json({ message: 'Enterprise deleted. Teachers kept as accounts and moved to free plan.' });
  } catch (err) { next(err); }
};

export const adminGetEnterpriseLogs = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(100, Math.max(10, parseInt(req.query.limit) || 40));
    const skip = (page - 1) * limit;
    const enterpriseId = req.params.id;

    const entUsers = await User.find({ enterpriseId }).select('_id name email').sort({ name: 1 }).lean();
    const userIds = entUsers.map(u => u._id);

    const filter = {
      $or: [
        { enterprise: enterpriseId },
        { user: { $in: userIds } },
      ],
    };
    if (req.query.userId) filter.user = req.query.userId;
    if (req.query.action) filter.action = req.query.action;
    if (req.query.from || req.query.to) {
      filter.createdAt = {};
      if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
      if (req.query.to) filter.createdAt.$lte = new Date(req.query.to);
    }
    if (req.query.search) {
      const pattern = new RegExp(String(req.query.search).trim(), 'i');
      filter.$and = [
        ...(filter.$and || []),
        {
          $or: [
            { action: pattern },
            { category: pattern },
            { severity: pattern },
          ],
        },
      ];
    }

    const [logs, total] = await Promise.all([
      ActivityLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('user', 'name email'),
      ActivityLog.countDocuments(filter),
    ]);

    res.json({ logs, total, page, pages: Math.ceil(total / limit), users: entUsers });
  } catch (err) { next(err); }
};

export const adminGetAllEnterpriseLogs = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(100, Math.max(10, parseInt(req.query.limit) || 40));
    const skip = (page - 1) * limit;
    const filter = { enterprise: { $ne: null } };
    if (req.query.enterpriseId) filter.enterprise = req.query.enterpriseId;
    if (req.query.userId) filter.user = req.query.userId;
    if (req.query.action) filter.action = req.query.action;
    if (req.query.from || req.query.to) {
      filter.createdAt = {};
      if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
      if (req.query.to) filter.createdAt.$lte = new Date(req.query.to);
    }
    const [logs, total, enterprises] = await Promise.all([
      ActivityLog.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('user', 'name email role')
        .populate('enterprise', 'name mode')
        .lean(),
      ActivityLog.countDocuments(filter),
      Enterprise.find().select('_id name mode').sort({ name: 1 }).lean(),
    ]);
    res.json({ logs, total, page, pages: Math.ceil(total / limit), enterprises });
  } catch (err) { next(err); }
};

// ── Principal ─────────────────────────────────────────────────────────────────

async function getPrincipalEnterprise(sessionUser) {
  if (sessionUser.role !== 'principal') return null;
  return Enterprise.findOne({ principalUser: sessionUser._id });
}

export const principalGetContext = async (req, res, next) => {
  try {
    const ent = await getPrincipalEnterprise(req.sessionUser);
    if (!ent) return next(new AppError('Enterprise not found', 404));
    const used = await teacherUsageCount(ent._id);
    res.json({
      enterprise: {
        id: ent._id,
        name: ent.name,
        mode: ent.mode,
        teacherLimit: ent.teacherLimit,
        examsPerTeacherLimit: ent.examsPerTeacherLimit,
        questionsPerExamLimit: ent.questionsPerExamLimit,
        aiProctoringEnabled: ent.aiProctoringEnabled !== false,
        estimatedMonthlyCost: ent.estimatedMonthlyCost || 0,
        teacherUsed: used,
        contactEmail: ent.contactEmail,
        phone: ent.phone,
        address: ent.address,
      },
    });
  } catch (err) { next(err); }
};

export const principalGetLogs = async (req, res, next) => {
  try {
    const ent = await getPrincipalEnterprise(req.sessionUser);
    if (!ent) return next(new AppError('Enterprise not found', 404));

    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(100, Math.max(10, parseInt(req.query.limit) || 40));
    const skip = (page - 1) * limit;

    const filter = { enterprise: ent._id };
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
      ActivityLog.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('user', 'name email role')
        .lean(),
      ActivityLog.countDocuments(filter),
    ]);

    res.json({ logs, total, page, pages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
};

export const principalGetLogStats = async (req, res, next) => {
  try {
    const ent = await getPrincipalEnterprise(req.sessionUser);
    if (!ent) return next(new AppError('Enterprise not found', 404));

    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const match = { enterprise: ent._id, createdAt: { $gte: since } };

    const [byAction, bySeverity, daily, byUser] = await Promise.all([
      ActivityLog.aggregate([
        { $match: match },
        { $group: { _id: '$action', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),
      ActivityLog.aggregate([
        { $match: match },
        { $group: { _id: '$severity', count: { $sum: 1 } } },
      ]),
      ActivityLog.aggregate([
        { $match: match },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
      ActivityLog.aggregate([
        { $match: match },
        { $group: { _id: '$user', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 20 },
      ]),
    ]);

    const userIds = byUser.map((u) => u._id).filter(Boolean);
    const users = await User.find({ _id: { $in: userIds } }).select('name email role').lean();
    const userMap = new Map(users.map((u) => [u._id.toString(), u]));
    const byUserResolved = byUser.map((u) => ({
      user: u._id ? (userMap.get(u._id.toString()) || { id: u._id, name: 'Unknown', email: '' }) : null,
      count: u.count,
    }));

    res.json({ byAction, bySeverity, daily, byUser: byUserResolved });
  } catch (err) { next(err); }
};

export const principalInviteTeacher = async (req, res, next) => {
  try {
    const ent = await getPrincipalEnterprise(req.sessionUser);
    if (!ent) return next(new AppError('Enterprise not found', 404));

    const { name, email } = req.body;
    if (!name?.trim() || !email?.trim()) return next(new AppError('Name and email are required', 400));
    const em = email.toLowerCase().trim();

    const used = await teacherUsageCount(ent._id);
    if (used >= ent.teacherLimit) {
      return next(new AppError(`Teacher limit reached (${ent.teacherLimit})`, 403));
    }

    const existingUser = await User.findOne({ email: em });
    if (existingUser?.enterpriseId?.toString() === ent._id.toString() && existingUser.role === 'instructor') {
      return next(new AppError('This user is already a teacher in your organization', 409));
    }

    const dup = await EnterpriseTeacherInvite.findOne({ enterprise: ent._id, email: em, status: 'pending' });
    if (dup) return next(new AppError('An invitation is already pending for this email', 409));

    const invite = await EnterpriseTeacherInvite.create({
      enterprise: ent._id,
      email: em,
      name: name.trim(),
      invitedBy: req.sessionUser._id,
    });

    const signupUrl = `${process.env.CLIENT_URL || 'http://localhost:5173'}/signup?enterpriseInvite=${invite.token}`;

    await sendEnterpriseTeacherInviteEmail({
      email: em,
      teacherName: name.trim(),
      enterpriseName: ent.name,
      principalName: req.sessionUser.name,
      signupUrl,
    }).catch(() => {});

    await log({
      user: req.sessionUser,
      action: 'enterprise_teacher_invited',
      category: 'enterprise',
      enterprise: ent._id,
      metadata: { inviteEmail: em, inviteName: name.trim() },
      ...fromReq(req),
    });

    res.status(201).json({ invite: { id: invite._id, email: invite.email, name: invite.name, status: invite.status } });
  } catch (err) { next(err); }
};

export const principalListTeachers = async (req, res, next) => {
  try {
    const ent = await getPrincipalEnterprise(req.sessionUser);
    if (!ent) return next(new AppError('Enterprise not found', 404));

    const instructors = await User.find({ enterpriseId: ent._id, role: 'instructor' })
      .select('name email createdAt isBlocked')
      .sort({ name: 1 })
      .lean();

    const invites = await EnterpriseTeacherInvite.find({ enterprise: ent._id, status: 'pending' })
      .select('email name status createdAt')
      .sort({ createdAt: -1 })
      .lean();

    const teachers = instructors.map(t => ({
      id: t._id,
      name: t.name,
      email: t.email,
      status: 'active',
      isBlocked: !!t.isBlocked,
      createdAt: t.createdAt,
    }));

    const pending = invites.map(i => ({
      id: i._id,
      name: i.name,
      email: i.email,
      status: 'pending',
      createdAt: i.createdAt,
    }));

    res.json({ teachers: [...pending, ...teachers] });
  } catch (err) { next(err); }
};

export const principalUpdateTeacher = async (req, res, next) => {
  try {
    const ent = await getPrincipalEnterprise(req.sessionUser);
    if (!ent) return next(new AppError('Enterprise not found', 404));
    const { name, email } = req.body;
    if (!name?.trim() || !email?.trim()) return next(new AppError('Name and email are required', 400));
    const em = email.toLowerCase().trim();

    const teacher = await User.findById(req.params.teacherId);
    if (!teacher || teacher.role !== 'instructor' || teacher.enterpriseId?.toString() !== ent._id.toString()) {
      return next(new AppError('Teacher not found', 404));
    }
    const dup = await User.findOne({ _id: { $ne: teacher._id }, email: em });
    if (dup) return next(new AppError('Email is already used by another account', 409));

    teacher.name = name.trim();
    teacher.email = em;
    await teacher.save();

    await log({
      user: req.sessionUser,
      action: 'profile_updated',
      category: 'enterprise',
      enterprise: ent._id,
      metadata: { teacherId: teacher._id.toString(), email: teacher.email },
      ...fromReq(req),
    });

    res.json({ message: 'Teacher updated' });
  } catch (err) { next(err); }
};

export const principalToggleTeacherBlock = async (req, res, next) => {
  try {
    const ent = await getPrincipalEnterprise(req.sessionUser);
    if (!ent) return next(new AppError('Enterprise not found', 404));
    const teacher = await User.findById(req.params.teacherId);
    if (!teacher || teacher.role !== 'instructor' || teacher.enterpriseId?.toString() !== ent._id.toString()) {
      return next(new AppError('Teacher not found', 404));
    }
    teacher.isBlocked = !teacher.isBlocked;
    await teacher.save({ validateBeforeSave: false });

    await log({
      user: req.sessionUser,
      action: teacher.isBlocked ? 'admin_user_blocked' : 'admin_user_unblocked',
      category: 'enterprise',
      enterprise: ent._id,
      metadata: { teacherId: teacher._id.toString(), email: teacher.email, byPrincipal: true },
      severity: teacher.isBlocked ? 'warning' : 'info',
      ...fromReq(req),
    });

    res.json({ message: `Teacher ${teacher.isBlocked ? 'blocked' : 'unblocked'}`, isBlocked: teacher.isBlocked });
  } catch (err) { next(err); }
};

export const principalRemoveTeacher = async (req, res, next) => {
  try {
    const ent = await getPrincipalEnterprise(req.sessionUser);
    if (!ent) return next(new AppError('Enterprise not found', 404));

    const target = await User.findById(req.params.teacherId);
    if (!target || target.enterpriseId?.toString() !== ent._id.toString()) {
      return next(new AppError('Teacher not found', 404));
    }
    if (target.role !== 'instructor') return next(new AppError('Invalid target', 400));

    target.enterpriseId = null;
    await target.save({ validateBeforeSave: false });

    await EnterpriseTeacherInvite.updateMany(
      { enterprise: ent._id, email: target.email },
      { status: 'cancelled' },
    );

    await log({
      user: req.sessionUser,
      action: 'enterprise_teacher_removed',
      category: 'enterprise',
      enterprise: ent._id,
      metadata: { removedUserId: target._id.toString(), email: target.email },
      ...fromReq(req),
    });

    res.json({ message: 'Teacher removed from organization' });
  } catch (err) { next(err); }
};

export const principalCancelInvite = async (req, res, next) => {
  try {
    const ent = await getPrincipalEnterprise(req.sessionUser);
    if (!ent) return next(new AppError('Enterprise not found', 404));

    const inv = await EnterpriseTeacherInvite.findOne({ _id: req.params.inviteId, enterprise: ent._id, status: 'pending' });
    if (!inv) return next(new AppError('Invite not found', 404));
    inv.status = 'cancelled';
    await inv.save();
    res.json({ message: 'Invitation cancelled' });
  } catch (err) { next(err); }
};

export const principalImpersonateTeacher = async (req, res, next) => {
  try {
    const ent = await getPrincipalEnterprise(req.sessionUser);
    if (!ent) return next(new AppError('Enterprise not found', 404));

    const teacher = await User.findById(req.params.teacherId).select('+refreshToken');
    if (!teacher || teacher.role !== 'instructor' || teacher.enterpriseId?.toString() !== ent._id.toString()) {
      return next(new AppError('Teacher not found', 403));
    }

    const { refreshToken } = setAuthCookies(res, req.sessionUser._id, { actAs: teacher._id });
    await User.findByIdAndUpdate(req.sessionUser._id, { refreshToken });

    await log({
      user: req.sessionUser,
      action: 'enterprise_impersonation_started',
      category: 'enterprise',
      enterprise: ent._id,
      metadata: {
        targetUserId: teacher._id.toString(),
        targetEmail: teacher.email,
        targetName: teacher.name,
      },
      severity: 'warning',
      ...fromReq(req),
    });

    res.json({
      message: 'View mode started',
      user: {
        id: teacher._id,
        name: teacher.name,
        email: teacher.email,
        role: teacher.role,
      },
    });
  } catch (err) { next(err); }
};

export const principalStopImpersonation = async (req, res, next) => {
  try {
    if (!req.isImpersonating || req.sessionUser.role !== 'principal') {
      return next(new AppError('Not in view mode', 400));
    }

    const ent = await getPrincipalEnterprise(req.sessionUser);
    const { refreshToken } = setAuthCookies(res, req.sessionUser._id);
    await User.findByIdAndUpdate(req.sessionUser._id, { refreshToken });

    if (ent) {
      await log({
        user: req.sessionUser,
        action: 'enterprise_impersonation_ended',
        category: 'enterprise',
        enterprise: ent._id,
        metadata: { viewedAsUserId: req.user._id.toString() },
        ...fromReq(req),
      });
    }

    res.json({ message: 'View mode ended' });
  } catch (err) { next(err); }
};

// ── School mode (instructors in enterprise) ─────────────────────────────────

export const enterpriseListClasses = async (req, res, next) => {
  try {
    if (!req.user.enterpriseId) return next(new AppError('No enterprise', 403));
    const ent = await Enterprise.findById(req.user.enterpriseId);
    if (!ent || ent.mode !== 'school') return next(new AppError('School mode only', 403));

    const classes = await SchoolClass.find({ enterprise: ent._id })
      .populate('teacher', 'name email')
      .sort({ name: 1 })
      .lean();
    const classIds = classes.map((c) => c._id);
    const studentCounts = await User.aggregate([
      { $match: { enterpriseId: ent._id, role: 'user', schoolClassId: { $in: classIds } } },
      { $group: { _id: '$schoolClassId', count: { $sum: 1 } } },
    ]);
    const countMap = new Map(studentCounts.map((x) => [x._id.toString(), x.count]));
    const withCounts = classes.map((c) => ({
      ...c,
      studentCount: countMap.get(c._id.toString()) || 0,
    }));
    res.json({ classes: withCounts });
  } catch (err) { next(err); }
};

export const enterpriseCreateClass = async (req, res, next) => {
  try {
    if (!['instructor', 'admin'].includes(req.user.role)) return next(new AppError('Forbidden', 403));
    if (!req.user.enterpriseId) return next(new AppError('No enterprise', 403));
    const ent = await Enterprise.findById(req.user.enterpriseId);
    if (!ent || ent.mode !== 'school') return next(new AppError('School mode only', 403));

    const { name, section = '', academicYear = '' } = req.body;
    if (!name?.trim()) return next(new AppError('Class name is required', 400));

    const c = await SchoolClass.create({
      enterprise: ent._id,
      teacher: req.user._id,
      name: name.trim(),
      section: String(section).trim(),
      academicYear: String(academicYear).trim(),
    });
    res.status(201).json({ class: c });
  } catch (err) { next(err); }
};

export const enterpriseListStudents = async (req, res, next) => {
  try {
    if (!req.user.enterpriseId) return next(new AppError('No enterprise', 403));
    const ent = await Enterprise.findById(req.user.enterpriseId);
    if (!ent || ent.mode !== 'school') return next(new AppError('School mode only', 403));

    const q = { enterpriseId: ent._id, role: 'user' };
    if (req.query.classId) q.schoolClassId = req.query.classId;

    const students = await User.find(q).select('name email schoolClassId createdAt').populate('schoolClassId', 'name section').sort({ name: 1 }).lean();
    res.json({ students });
  } catch (err) { next(err); }
};

/** For users who already have an account: attach to enterprise as instructor. */
export const acceptEnterpriseInviteLoggedIn = async (req, res, next) => {
  try {
    const invite = await EnterpriseTeacherInvite.findOne({
      token: req.params.token,
      status: 'pending',
    });
    if (!invite || invite.email !== req.user.email.toLowerCase()) {
      return next(new AppError('Invalid or expired invitation', 400));
    }
    if (req.user.role === 'admin' || req.user.role === 'principal') {
      return next(new AppError('This account type cannot accept a teacher invitation', 403));
    }
    if (req.user.enterpriseId) {
      return next(new AppError('Your account is already linked to an organization', 409));
    }
    const ent = await Enterprise.findById(invite.enterprise);
    if (!ent) return next(new AppError('Organization not found', 404));

    const used = await teacherUsageCount(ent._id);
    if (used >= ent.teacherLimit) {
      return next(new AppError('This organization has reached its teacher limit', 403));
    }

    invite.status = 'accepted';
    await invite.save();
    req.user.role = 'instructor';
    req.user.enterpriseId = ent._id;
    if (req.user.plan === 'free') req.user.plan = 'enterprise';
    await req.user.save({ validateBeforeSave: false });

    await log({
      user: req.user,
      action: 'enterprise_teacher_joined',
      category: 'enterprise',
      enterprise: ent._id,
      metadata: { via: 'invite_accept_existing' },
      ...fromReq(req),
    });

    res.json({ message: 'You joined the organization', redirectPath: '/instructor-dashboard' });
  } catch (err) { next(err); }
};

export const enterpriseInviteStudent = async (req, res, next) => {
  try {
    if (!['instructor', 'admin'].includes(req.user.role)) return next(new AppError('Forbidden', 403));
    if (!req.user.enterpriseId) return next(new AppError('No enterprise', 403));
    const ent = await Enterprise.findById(req.user.enterpriseId);
    if (!ent || ent.mode !== 'school') return next(new AppError('School mode only', 403));

    const { name, email, schoolClassId } = req.body;
    if (!name?.trim() || !email?.trim() || !schoolClassId) {
      return next(new AppError('Name, email, and class are required', 400));
    }

    const cls = await SchoolClass.findOne({ _id: schoolClassId, enterprise: ent._id });
    if (!cls) return next(new AppError('Class not found', 404));

    const em = email.toLowerCase().trim();
    const existing = await User.findOne({ email: em });
    if (existing) return next(new AppError('An account with this email already exists', 409));

    const password = crypto.randomBytes(12).toString('hex');
    const student = await User.create({
      name: name.trim(),
      email: em,
      password,
      role: 'user',
      enterpriseId: ent._id,
      schoolClassId: cls._id,
    });

    res.status(201).json({
      student: {
        id: student._id,
        name: student.name,
        email: student.email,
        schoolClassId: student.schoolClassId,
      },
      note: 'Share password reset from login if needed.',
    });
  } catch (err) { next(err); }
};

export const enterpriseBulkInviteStudents = async (req, res, next) => {
  try {
    if (!['instructor', 'admin'].includes(req.user.role)) return next(new AppError('Forbidden', 403));
    if (!req.user.enterpriseId) return next(new AppError('No enterprise', 403));
    const ent = await Enterprise.findById(req.user.enterpriseId);
    if (!ent || ent.mode !== 'school') return next(new AppError('School mode only', 403));
    const rows = Array.isArray(req.body.students) ? req.body.students : [];
    if (!rows.length) return next(new AppError('students array is required', 400));

    const classIds = [...new Set(rows.map((r) => r.schoolClassId).filter(Boolean))];
    const classes = await SchoolClass.find({ _id: { $in: classIds }, enterprise: ent._id }).select('_id');
    const validClassIds = new Set(classes.map((c) => c._id.toString()));
    const emails = rows.map((r) => String(r.email || '').toLowerCase().trim()).filter(Boolean);
    const existingUsers = await User.find({ email: { $in: emails } }).select('email').lean();
    const existingEmailSet = new Set(existingUsers.map((u) => u.email.toLowerCase()));

    const errors = [];
    const valid = [];
    rows.forEach((row, idx) => {
      const name = String(row.name || '').trim();
      const email = String(row.email || '').toLowerCase().trim();
      const schoolClassId = String(row.schoolClassId || '');
      if (!name || !email || !schoolClassId) {
        errors.push({ row: idx + 1, email, message: 'name, email, and schoolClassId are required' });
        return;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        errors.push({ row: idx + 1, email, message: 'invalid email format' });
        return;
      }
      if (!validClassIds.has(schoolClassId)) {
        errors.push({ row: idx + 1, email, message: 'class not found in enterprise' });
        return;
      }
      if (existingEmailSet.has(email)) {
        errors.push({ row: idx + 1, email, message: 'email already exists' });
        return;
      }
      valid.push({ name, email, schoolClassId });
      existingEmailSet.add(email);
    });

    const docs = valid.map((v) => ({
      name: v.name,
      email: v.email,
      password: crypto.randomBytes(12).toString('hex'),
      role: 'user',
      enterpriseId: ent._id,
      schoolClassId: v.schoolClassId,
    }));
    if (docs.length) await User.insertMany(docs, { ordered: false });

    res.status(201).json({
      created: docs.length,
      failed: errors.length,
      errors,
      message: `Created ${docs.length} students${errors.length ? `, ${errors.length} failed` : ''}.`,
    });
  } catch (err) { next(err); }
};
