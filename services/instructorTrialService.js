import Plan from '../models/Plan.js';
import Subscription from '../models/Subscription.js';
import User from '../models/User.js';
import logger from '../utils/logger.js';

/** Active default instructor trial plan from the catalog (admin-controlled). */
export async function findDefaultInstructorTrialPlan() {
  return Plan.findOne({
    audience: 'individual',
    isActive: true,
    isDefaultInstructorTrial: true,
  }).lean();
}

/** Trial length in days from plan billing settings (falls back to schema default). */
export function resolveTrialDays(plan) {
  const days = Number(plan?.billing?.trialDays);
  return Number.isFinite(days) && days > 0 ? Math.floor(days) : 30;
}

export function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + Number(days));
  return d;
}

/**
 * Assign the current default instructor trial to a user.
 * Sets user fields, usage counters, and an active trial Subscription record.
 */
export async function assignInstructorTrialToUser(userOrId) {
  const user = userOrId?._id || typeof userOrId === 'object'
    ? userOrId
    : await User.findById(userOrId);
  if (!user) return { assigned: false, reason: 'user_not_found' };

  if (user.enterpriseId) {
    return { assigned: false, reason: 'enterprise_managed' };
  }

  const now = new Date();
  const trialActive = user.instructorTrialEndsAt && user.instructorTrialEndsAt > now;
  if (trialActive) {
    return { assigned: false, reason: 'trial_already_active', user };
  }

  if (user.instructorTrialUsed) {
    return { assigned: false, reason: 'trial_already_used', user };
  }

  const trialPlan = await findDefaultInstructorTrialPlan();
  if (!trialPlan) {
    logger.warn('Instructor trial skipped: no default instructor trial plan configured in catalog.');
    return { assigned: false, reason: 'no_default_trial_plan', user };
  }

  const trialDays = resolveTrialDays(trialPlan);
  const trialEnd = addDays(now, trialDays);

  user.instructorTrialUsed = true;
  user.instructorTrialEndsAt = trialEnd;
  user.plan = 'pro';
  user.planExpiresAt = trialEnd;
  user.individualPlanCode = trialPlan.code;
  user.examsCreatedThisMonth = 0;
  user.monthlyExamResetDate = now;
  await user.save({ validateBeforeSave: false });

  await Subscription.updateMany(
    {
      user: user._id,
      status: { $in: ['active', 'pending', 'payment_pending', 'grace_period'] },
      isTrial: { $ne: true },
    },
    { $set: { status: 'expired', autoRenewEnabled: false } },
  );

  await Subscription.findOneAndUpdate(
    { user: user._id, isTrial: true, individualPlanCode: trialPlan.code },
    {
      user: user._id,
      plan: 'pro',
      individualPlanCode: trialPlan.code,
      status: 'active',
      subscriptionStatus: 'trial',
      isTrial: true,
      provider: 'manual',
      amountPaid: 0,
      autoRenewEnabled: false,
      startDate: now,
      endDate: trialEnd,
      durationMonths: 1,
      billingCycle: 'multi',
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  return {
    assigned: true,
    user,
    plan: trialPlan,
    trialDays,
    trialEnd,
  };
}

/**
 * Apply instructor onboarding at signup: role + optional trial (skipped for org invites).
 */
export async function applyInstructorSignupOnboarding(user, { skipTrial = false, organizationType = 'school' } = {}) {
  if (!user) return user;
  user.role = 'instructor';
  const ot = String(organizationType || 'school').toLowerCase();
  user.organizationType = ot === 'institute' ? 'institute' : 'school';
  await user.save({ validateBeforeSave: false });

  if (skipTrial) return user;

  await assignInstructorTrialToUser(user);
  return User.findById(user._id);
}

/** Expire trial subscription rows when the instructor trial window has ended. */
export async function expireTrialSubscriptionsForUser(userId) {
  const now = new Date();
  await Subscription.updateMany(
    {
      user: userId,
      isTrial: true,
      status: 'active',
      endDate: { $lte: now },
    },
    { $set: { status: 'expired', autoRenewEnabled: false } },
  );
}
