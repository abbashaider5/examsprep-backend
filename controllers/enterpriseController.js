import crypto from 'crypto';
import { AppError } from '../middleware/errorHandler.js';
import { setAuthCookies } from '../middleware/auth.js';
import Enterprise from '../models/Enterprise.js';
import EnterpriseTeacherInvite from '../models/EnterpriseTeacherInvite.js';
import ChatModerationLog from '../models/ChatModerationLog.js';
import Group from '../models/Group.js';
import GroupChatModeration from '../models/GroupChatModeration.js';
import GroupMessage from '../models/GroupMessage.js';
import SchoolClass from '../models/SchoolClass.js';
import SchoolClassEnrollment from '../models/SchoolClassEnrollment.js';
import { getSettings } from '../models/SystemSettings.js';
import User from '../models/User.js';
import { delCache } from '../services/cacheService.js';
import {
  ensureSchoolChatInfrastructure,
  ensureSchoolClassChatGroup,
  enrollUserInSchoolClass,
  syncSchoolClassChatGroupTitle,
  userHasSchoolClassAccess,
} from '../services/schoolClassChatService.js';
import ActivityLog from '../models/ActivityLog.js';
import { log, fromReq } from '../utils/activityLogger.js';
import { sendEnterprisePrincipalWelcomeEmail, sendEnterpriseTeacherInviteEmail } from '../services/emailService.js';

function canManageSchoolClass(cls, reqUser, ent) {
  if (!cls || !ent) return false;
  if (reqUser.role === 'admin') return true;
  if (reqUser.role === 'principal' && reqUser.enterpriseId?.toString() === ent._id.toString()) return true;
  if (reqUser.role === 'instructor' && cls.teacher?.toString() === reqUser._id.toString()) return true;
  return false;
}

/** Case-insensitive email match so existing accounts are reused (avoids duplicate key + missed reuse). */
async function findUserByEmailCaseInsensitive(email) {
  const em = String(email || '').toLowerCase().trim();
  if (!em) return null;
  let u = await User.findOne({ email: em });
  if (u) return u;
  try {
    u = await User.findOne({ email: em }).collation({ locale: 'en', strength: 2 });
  } catch {
    u = null;
  }
  if (u) return u;
  return User.findOne({ $expr: { $eq: [{ $toLower: '$email' }, em] } });
}

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

    const schoolClasses = await SchoolClass.find({ enterprise: ent._id }).select('chatGroup').lean();
    const chatGroupIds = schoolClasses.map((c) => c.chatGroup).filter(Boolean);
    if (chatGroupIds.length) {
      await GroupMessage.deleteMany({ group: { $in: chatGroupIds } });
      await ChatModerationLog.deleteMany({ group: { $in: chatGroupIds } });
      await GroupChatModeration.deleteMany({ group: { $in: chatGroupIds } });
      await Group.deleteMany({ _id: { $in: chatGroupIds } });
    }
    await SchoolClassEnrollment.deleteMany({ enterprise: ent._id });
    await SchoolClass.deleteMany({ enterprise: ent._id });

    await User.updateMany(
      { enterpriseId: ent._id, role: 'user' },
      { $set: { enterpriseId: null, schoolClassId: null, plan: 'free' } },
    );

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

    await ensureSchoolChatInfrastructure(ent._id);

    const classes = await SchoolClass.find({ enterprise: ent._id })
      .populate('teacher', 'name email')
      .sort({ name: 1 })
      .lean();
    const countAgg = await SchoolClassEnrollment.aggregate([
      { $match: { enterprise: ent._id } },
      { $group: { _id: '$schoolClass', count: { $sum: 1 } } },
    ]);
    const countMap = new Map(countAgg.map((x) => [x._id.toString(), x.count]));
    const withCounts = classes.map((c) => ({
      ...c,
      studentCount: countMap.get(c._id.toString()) || 0,
      chatGroupId: c.chatGroup || null,
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
    const created = await SchoolClass.findById(c._id);
    try {
      await ensureSchoolClassChatGroup(created);
    } catch {
      /* teacher always set on create */
    }
    res.status(201).json({ class: c });
  } catch (err) { next(err); }
};

export const enterpriseUpdateClass = async (req, res, next) => {
  try {
    if (!['instructor', 'admin', 'principal'].includes(req.user.role)) return next(new AppError('Forbidden', 403));
    if (!req.user.enterpriseId) return next(new AppError('No enterprise', 403));
    const ent = await Enterprise.findById(req.user.enterpriseId);
    if (!ent || ent.mode !== 'school') return next(new AppError('School mode only', 403));

    const cls = await SchoolClass.findOne({ _id: req.params.classId, enterprise: ent._id });
    if (!cls) return next(new AppError('Class not found', 404));
    if (!canManageSchoolClass(cls, req.user, ent)) return next(new AppError('Forbidden', 403));

    const { name, section, academicYear } = req.body;
    if (name !== undefined) {
      const t = String(name).trim();
      if (!t) return next(new AppError('Class name is required', 400));
      cls.name = t;
    }
    if (section !== undefined) cls.section = String(section ?? '').trim();
    if (academicYear !== undefined) cls.academicYear = String(academicYear ?? '').trim();
    await cls.save();

    const fresh = await SchoolClass.findById(cls._id);
    try {
      await ensureSchoolClassChatGroup(fresh);
      await syncSchoolClassChatGroupTitle(fresh);
    } catch {
      /* class may lack teacher in edge cases */
    }
    res.json({ class: fresh });
  } catch (err) { next(err); }
};

export const enterpriseDeleteClass = async (req, res, next) => {
  try {
    if (!['instructor', 'admin', 'principal'].includes(req.user.role)) return next(new AppError('Forbidden', 403));
    if (!req.user.enterpriseId) return next(new AppError('No enterprise', 403));
    const ent = await Enterprise.findById(req.user.enterpriseId);
    if (!ent || ent.mode !== 'school') return next(new AppError('School mode only', 403));

    const cls = await SchoolClass.findOne({ _id: req.params.classId, enterprise: ent._id });
    if (!cls) return next(new AppError('Class not found', 404));
    if (!canManageSchoolClass(cls, req.user, ent)) return next(new AppError('Forbidden', 403));

    const enrollCount = await SchoolClassEnrollment.countDocuments({ schoolClass: cls._id });
    const legacyOnClass = await User.countDocuments({
      schoolClassId: cls._id,
      enterpriseId: ent._id,
      role: 'user',
    });
    if (enrollCount > 0 || legacyOnClass > 0) {
      return next(new AppError('Remove all students from this class before deleting it.', 400));
    }

    const gid = cls.chatGroup;
    const teacherId = cls.teacher;
    if (gid) {
      await GroupMessage.deleteMany({ group: gid });
      await ChatModerationLog.deleteMany({ group: gid });
      await GroupChatModeration.deleteMany({ group: gid });
      await Group.findByIdAndDelete(gid);
    }
    await SchoolClass.findByIdAndDelete(cls._id);
    if (teacherId) await delCache(`groups:${teacherId}`);
    res.json({ message: 'Class deleted' });
  } catch (err) { next(err); }
};

export const enterpriseListStudents = async (req, res, next) => {
  try {
    if (!req.user.enterpriseId) return next(new AppError('No enterprise', 403));
    const ent = await Enterprise.findById(req.user.enterpriseId);
    if (!ent || ent.mode !== 'school') return next(new AppError('School mode only', 403));

    await ensureSchoolChatInfrastructure(ent._id);

    if (req.query.classId) {
      const cls = await SchoolClass.findOne({ _id: req.query.classId, enterprise: ent._id })
        .select('name section')
        .lean();
      if (!cls) return next(new AppError('Class not found', 404));

      const rows = await SchoolClassEnrollment.find({
        schoolClass: req.query.classId,
        enterprise: ent._id,
      })
        .populate('user', 'name email createdAt')
        .sort({ createdAt: -1 })
        .lean();

      const students = rows
        .filter((r) => r.user)
        .map((r) => ({
          _id: r.user._id,
          name: r.user.name,
          email: r.user.email,
          createdAt: r.user.createdAt,
          schoolClassId: { _id: cls._id, name: cls.name, section: cls.section },
        }));
      return res.json({ students });
    }

    const rows = await SchoolClassEnrollment.find({ enterprise: ent._id })
      .populate('user', 'name email createdAt')
      .populate('schoolClass', 'name section')
      .lean();

    const students = rows
      .filter((r) => r.user && r.schoolClass)
      .map((r) => ({
        _id: r.user._id,
        name: r.user.name,
        email: r.user.email,
        createdAt: r.user.createdAt,
        schoolClassId: r.schoolClass,
      }));
    students.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    res.json({ students });
  } catch (err) { next(err); }
};

export const enterpriseUpdateStudent = async (req, res, next) => {
  try {
    if (!['instructor', 'admin', 'principal'].includes(req.user.role)) return next(new AppError('Forbidden', 403));
    if (!req.user.enterpriseId) return next(new AppError('No enterprise', 403));
    const ent = await Enterprise.findById(req.user.enterpriseId);
    if (!ent || ent.mode !== 'school') return next(new AppError('School mode only', 403));

    const target = await User.findById(req.params.userId);
    if (!target || target.role !== 'user') return next(new AppError('Student not found', 404));
    if (target.enterpriseId?.toString() !== ent._id.toString()) {
      return next(new AppError('Student not in this organization', 403));
    }

    const { name, email } = req.body;
    if (name === undefined && email === undefined) {
      return next(new AppError('Provide name and/or email to update', 400));
    }
    if (name !== undefined) {
      const t = String(name).trim();
      if (!t) return next(new AppError('Name is required', 400));
      target.name = t;
    }
    if (email !== undefined) {
      const em = String(email).toLowerCase().trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return next(new AppError('Invalid email', 400));
      const conflict = await User.findOne({ email: em, _id: { $ne: target._id } });
      if (conflict) return next(new AppError('Another account already uses this email', 409));
      target.email = em;
    }
    await target.save({ validateBeforeSave: false });
    res.json({ student: { id: target._id, name: target.name, email: target.email } });
  } catch (err) { next(err); }
};

export const enterpriseDeleteStudent = async (req, res, next) => {
  try {
    if (!['instructor', 'admin', 'principal'].includes(req.user.role)) return next(new AppError('Forbidden', 403));
    if (!req.user.enterpriseId) return next(new AppError('No enterprise', 403));
    const ent = await Enterprise.findById(req.user.enterpriseId);
    if (!ent || ent.mode !== 'school') return next(new AppError('School mode only', 403));

    const target = await User.findById(req.params.userId);
    if (!target || target.role !== 'user') return next(new AppError('Student not found', 404));
    if (target.enterpriseId?.toString() !== ent._id.toString()) {
      return next(new AppError('Student not in this organization', 403));
    }

    const enrollCount = await SchoolClassEnrollment.countDocuments({ user: target._id, enterprise: ent._id });
    if (enrollCount > 0) {
      return next(new AppError('This student is still enrolled in one or more classes. Remove them from all classes before deleting their account.', 400));
    }
    if (target.schoolClassId) {
      const legacyCls = await SchoolClass.findOne({ _id: target.schoolClassId, enterprise: ent._id }).select('_id').lean();
      if (legacyCls) {
        return next(new AppError('This student is still linked to a class roster. Remove them from all classes before deleting their account.', 400));
      }
    }

    await User.findByIdAndDelete(target._id);
    res.json({ message: 'Student removed' });
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
    const existing = await findUserByEmailCaseInsensitive(em);

    if (existing) {
      if (existing.role !== 'user') {
        return next(new AppError('This account cannot be enrolled as a student in this class.', 400));
      }
      if (existing.enterpriseId && existing.enterpriseId.toString() !== ent._id.toString()) {
        return next(new AppError('This student belongs to a different organization.', 403));
      }
      const dup = await SchoolClassEnrollment.exists({ schoolClass: cls._id, user: existing._id });
      if (dup) return next(new AppError('This student is already enrolled in this class.', 409));

      if (!existing.enterpriseId) {
        existing.enterpriseId = ent._id;
        if (existing.plan === 'free') existing.plan = 'enterprise';
        await existing.save({ validateBeforeSave: false });
      }
      if (!existing.schoolClassId) {
        existing.schoolClassId = cls._id;
      }
      if (existing.email !== em) {
        existing.email = em;
      }
      await existing.save({ validateBeforeSave: false });

      await enrollUserInSchoolClass(existing, cls._id, ent._id);

      return res.status(200).json({
        student: {
          id: existing._id,
          name: existing.name,
          email: existing.email,
          schoolClassId: cls._id,
        },
        reusedAccount: true,
        note: 'Existing account linked to this class. No duplicate user created.',
      });
    }

    const password = crypto.randomBytes(12).toString('hex');
    let student;
    try {
      student = await User.create({
        name: name.trim(),
        email: em,
        password,
        role: 'user',
        enterpriseId: ent._id,
        schoolClassId: cls._id,
        plan: 'enterprise',
      });
    } catch (createErr) {
      if (createErr?.code !== 11000) throw createErr;
      const again = await findUserByEmailCaseInsensitive(em);
      if (!again || again.role !== 'user') {
        return next(new AppError('Unable to link student account. Try again or use a different email.', 409));
      }
      if (again.enterpriseId && again.enterpriseId.toString() !== ent._id.toString()) {
        return next(new AppError('This student belongs to a different organization.', 403));
      }
      const dupRace = await SchoolClassEnrollment.exists({ schoolClass: cls._id, user: again._id });
      if (dupRace) return next(new AppError('This student is already enrolled in this class.', 409));
      if (!again.enterpriseId) {
        again.enterpriseId = ent._id;
        if (again.plan === 'free') again.plan = 'enterprise';
      }
      if (!again.schoolClassId) again.schoolClassId = cls._id;
      if (again.email !== em) again.email = em;
      await again.save({ validateBeforeSave: false });
      await enrollUserInSchoolClass(again, cls._id, ent._id);
      return res.status(200).json({
        student: {
          id: again._id,
          name: again.name,
          email: again.email,
          schoolClassId: cls._id,
        },
        reusedAccount: true,
        note: 'Existing account linked to this class. No duplicate user created.',
      });
    }

    await enrollUserInSchoolClass(student, cls._id, ent._id);

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

    const errors = [];
    let created = 0;
    let enrolledExisting = 0;

    for (let idx = 0; idx < rows.length; idx++) {
      const row = rows[idx];
      const name = String(row.name || '').trim();
      const email = String(row.email || '').toLowerCase().trim();
      const schoolClassId = String(row.schoolClassId || '');
      if (!name || !email || !schoolClassId) {
        errors.push({ row: idx + 1, email, message: 'name, email, and schoolClassId are required' });
        continue;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        errors.push({ row: idx + 1, email, message: 'invalid email format' });
        continue;
      }
      if (!validClassIds.has(schoolClassId)) {
        errors.push({ row: idx + 1, email, message: 'class not found in enterprise' });
        continue;
      }

      const cls = await SchoolClass.findOne({ _id: schoolClassId, enterprise: ent._id });
      if (!cls) {
        errors.push({ row: idx + 1, email, message: 'class not found' });
        continue;
      }

      const existing = await findUserByEmailCaseInsensitive(email);
      if (existing) {
        if (existing.role !== 'user') {
          errors.push({ row: idx + 1, email, message: 'account is not a student account' });
          continue;
        }
        if (existing.enterpriseId && existing.enterpriseId.toString() !== ent._id.toString()) {
          errors.push({ row: idx + 1, email, message: 'belongs to another organization' });
          continue;
        }
        const dup = await SchoolClassEnrollment.exists({ schoolClass: cls._id, user: existing._id });
        if (dup) {
          errors.push({ row: idx + 1, email, message: 'already enrolled in this class' });
          continue;
        }
        try {
          if (!existing.enterpriseId) {
            existing.enterpriseId = ent._id;
            if (existing.plan === 'free') existing.plan = 'enterprise';
          }
          if (!existing.schoolClassId) existing.schoolClassId = cls._id;
          await existing.save({ validateBeforeSave: false });
          await enrollUserInSchoolClass(existing, cls._id, ent._id);
          enrolledExisting++;
        } catch (e) {
          errors.push({ row: idx + 1, email, message: e.message || 'enroll failed' });
        }
        continue;
      }

      try {
        const password = crypto.randomBytes(12).toString('hex');
        const student = await User.create({
          name,
          email,
          password,
          role: 'user',
          enterpriseId: ent._id,
          schoolClassId: cls._id,
          plan: 'enterprise',
        });
        await enrollUserInSchoolClass(student, cls._id, ent._id);
        created++;
      } catch (e) {
        errors.push({ row: idx + 1, email, message: e.message || 'create failed' });
      }
    }

    res.status(201).json({
      created,
      enrolledExisting,
      failed: errors.length,
      errors,
      message: `Created ${created} new student(s), linked ${enrolledExisting} existing account(s)${errors.length ? `, ${errors.length} row(s) failed` : ''}.`,
    });
  } catch (err) { next(err); }
};

/** Resolve shadow Group id for class chat (same stack as batch chat). */
export const enterpriseGetClassChatGroup = async (req, res, next) => {
  try {
    if (!req.user.enterpriseId) return next(new AppError('No enterprise', 403));
    const ent = await Enterprise.findById(req.user.enterpriseId);
    if (!ent || ent.mode !== 'school') return next(new AppError('School mode only', 403));

    const cls = await SchoolClass.findOne({ _id: req.params.classId, enterprise: ent._id });
    if (!cls) return next(new AppError('Class not found', 404));

    const isAssignedTeacher = cls.teacher?.toString() === req.user._id.toString();

    if (req.user.role === 'instructor' || req.user.role === 'admin') {
      if (!isAssignedTeacher) return next(new AppError('Only the teacher assigned to this class can open class chat.', 403));
    } else if (req.user.role === 'user') {
      if (!(await userHasSchoolClassAccess(req.user, cls))) {
        return next(new AppError('You are not enrolled in this class.', 403));
      }
    } else {
      return next(new AppError('Forbidden', 403));
    }

    await ensureSchoolClassChatGroup(cls);
    const fresh = await SchoolClass.findById(cls._id);
    res.json({ groupId: fresh.chatGroup });
  } catch (err) { next(err); }
};

/** Student: classes they are enrolled in with chat group ids. */
export const enterpriseListMySchoolChats = async (req, res, next) => {
  try {
    if (!req.user.enterpriseId) return next(new AppError('No enterprise', 403));
    const ent = await Enterprise.findById(req.user.enterpriseId);
    if (!ent || ent.mode !== 'school') return next(new AppError('School mode only', 403));
    if (req.user.role !== 'user') return next(new AppError('Forbidden', 403));

    await ensureSchoolChatInfrastructure(ent._id);

    let enrollmentRows = await SchoolClassEnrollment.find({
      user: req.user._id,
      enterprise: ent._id,
    }).lean();

    const classIdSet = new Set(enrollmentRows.map((r) => r.schoolClass.toString()));
    if (req.user.schoolClassId && !classIdSet.has(req.user.schoolClassId.toString())) {
      const legacyCls = await SchoolClass.findOne({
        _id: req.user.schoolClassId,
        enterprise: ent._id,
      }).select('_id').lean();
      if (legacyCls) enrollmentRows = [...enrollmentRows, { schoolClass: legacyCls._id }];
    }

    const classIds = [...new Set(enrollmentRows.map((r) => r.schoolClass.toString()))];
    const classes = await SchoolClass.find({ _id: { $in: classIds }, enterprise: ent._id }).lean();

    const out = [];
    for (const c of classes) {
      if (!c.teacher) continue;
      try {
        await ensureSchoolClassChatGroup(c);
      } catch {
        continue;
      }
      const fresh = await SchoolClass.findById(c._id);
      if (!fresh?.chatGroup) continue;
      out.push({
        classId: fresh._id,
        name: fresh.name,
        section: fresh.section || '',
        chatGroupId: fresh.chatGroup,
      });
    }
    out.sort((a, b) => `${a.name} ${a.section}`.localeCompare(`${b.name} ${b.section}`));
    res.json({ classes: out });
  } catch (err) { next(err); }
};
