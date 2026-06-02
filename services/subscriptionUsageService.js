import Enterprise from '../models/Enterprise.js';
import User from '../models/User.js';
import {
  effectivePlanType,
  effectivePlanTypeWithEnterprise,
  getUserPlanLimits,
} from './userPlanLimitsService.js';
import {
  enterpriseSubscriptionIsActive,
  processEnterpriseSubscriptionLifecycle,
  processPersonalSubscriptionLifecycle,
} from './subscriptionLifecycleService.js';

export { effectivePlanType, effectivePlanTypeWithEnterprise } from './userPlanLimitsService.js';

export function hasActivePersonalPaidPlan(user) {
  if (!user?.planExpiresAt) return false;
  if (user.planExpiresAt < new Date()) return false;
  return user.plan === 'pro' || user.plan === 'enterprise';
}

export async function hasActivePaidPlanForCredits(user) {
  if (hasActivePersonalPaidPlan(user)) return true;
  if (!user?.enterpriseId) return false;
  const ent = await Enterprise.findById(user.enterpriseId).select('orgPlanExpiresAt orgTrialEndsAt').lean();
  return enterpriseSubscriptionIsActive(ent);
}

export async function ensureUserSubscriptionLifecycle(userId) {
  await processPersonalSubscriptionLifecycle(userId);
  const u = await User.findById(userId).select('enterpriseId').lean();
  if (u?.enterpriseId) {
    await processEnterpriseSubscriptionLifecycle(u.enterpriseId);
  }
}

export async function normalizeExpiredPlanForUser(userId) {
  await ensureUserSubscriptionLifecycle(userId);
}

/** Persist calendar-month reset when crossed (fixes stale monthly counts). */
export async function refreshMonthlyUsageIfNeeded(userId) {
  const user = await User.findById(userId);
  if (!user) return null;
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${now.getMonth()}`;
  const lastMonth = user.monthlyExamResetDate
    ? `${user.monthlyExamResetDate.getFullYear()}-${user.monthlyExamResetDate.getMonth()}`
    : null;
  if (lastMonth !== thisMonth) {
    await User.findByIdAndUpdate(userId, {
      $set: { examsCreatedThisMonth: 0, monthlyExamResetDate: now },
    });
    user.examsCreatedThisMonth = 0;
    user.monthlyExamResetDate = now;
  }
  return user;
}

async function planBaseMonthlyExamLimit(user) {
  const ctx = await getUserPlanLimits(user);
  return ctx?.limits?.examsPerMonth ?? 3;
}

/**
 * @param {import('mongoose').Types.ObjectId|string} userId
 * @param {number|null|undefined} enterpriseExamsPerTeacherLimit — when set (enterprise instructor/principal), caps base before bonus.
 * @param {{ skipLifecycle?: boolean }} opts
 */
export async function computeExamUsageSnapshot(userId, enterpriseExamsPerTeacherLimit = null, opts = {}) {
  if (!opts.skipLifecycle) await ensureUserSubscriptionLifecycle(userId);
  await refreshMonthlyUsageIfNeeded(userId);
  const user = await User.findById(userId);
  if (!user) return null;

  const eff = effectivePlanType(user);
  let baseCap = await planBaseMonthlyExamLimit(user);
  if (enterpriseExamsPerTeacherLimit != null && Number.isFinite(enterpriseExamsPerTeacherLimit)) {
    baseCap = Math.max(1, enterpriseExamsPerTeacherLimit);
  }

  const bonusSlots = hasActivePersonalPaidPlan(user) ? Math.max(0, Number(user.extraExamCreditsBalance) || 0) : 0;
  const totalCap = baseCap + bonusSlots;
  const used = Math.max(0, Number(user.examsCreatedThisMonth) || 0);
  const remaining = Math.max(0, totalCap - used);

  return {
    user,
    effectivePlan: eff,
    storedPlan: user.plan,
    baseMonthlyCap: baseCap,
    bonusSlots,
    totalCap,
    usedThisMonth: used,
    remaining,
    planExpiresAt: user.planExpiresAt || null,
  };
}

/**
 * Atomically increments usage after a successful exam persist.
 * @returns {Promise<import('mongoose').Document|null>} updated user or null if cap exceeded (race).
 */
export async function consumeExamGenerationSlots(userId, usageMultiplier, enterpriseExamsPerTeacherLimit = null) {
  const snap = await computeExamUsageSnapshot(userId, enterpriseExamsPerTeacherLimit);
  if (!snap) return null;
  const { totalCap } = snap;
  const mult = Math.max(1, Number(usageMultiplier) || 1);
  const now = new Date();

  const updated = await User.findOneAndUpdate(
    {
      _id: userId,
      $expr: {
        $lte: [
          { $add: [{ $ifNull: ['$examsCreatedThisMonth', 0] }, mult] },
          totalCap,
        ],
      },
    },
    {
      $inc: {
        examsCreatedThisMonth: mult,
        lifetimeExamsCreated: mult,
        examCreationsToday: 1,
      },
      $set: { lastExamCreationDate: now },
    },
    { new: true },
  );
  return updated;
}

export async function computeExamUsageSnapshotWithEnterprise(user) {
  if (!user?._id) return null;
  await ensureUserSubscriptionLifecycle(user._id);
  const fresh = await User.findById(user._id);
  if (!fresh) return null;
  let entExamCap = null;
  if (fresh.enterpriseId && (fresh.role === 'instructor' || fresh.role === 'principal')) {
    const ent = await Enterprise.findById(fresh.enterpriseId)
      .select('examsPerTeacherLimit questionsPerExamLimit orgPlanExpiresAt orgTrialEndsAt')
      .lean();
    if (enterpriseSubscriptionIsActive(ent)) {
      entExamCap = ent?.examsPerTeacherLimit ?? null;
    }
  }
  return computeExamUsageSnapshot(fresh._id, entExamCap, { skipLifecycle: true });
}

export async function getMaxQuestionsForUser(user, enterpriseQuestionsLimit = null) {
  if (enterpriseQuestionsLimit != null && Number.isFinite(enterpriseQuestionsLimit)) {
    return enterpriseQuestionsLimit;
  }
  const ctx = await getUserPlanLimits(user);
  return ctx?.limits?.questionsPerExam ?? 20;
}

export async function canUseProctoringForUser(user, enterpriseConfig = null) {
  if (enterpriseConfig && enterpriseConfig.aiProctoringEnabled === false) return false;
  const ctx = await getUserPlanLimits(user);
  return ctx?.features?.aiProctoring === true;
}
