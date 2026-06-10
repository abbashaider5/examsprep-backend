import crypto from 'crypto';
import Razorpay from 'razorpay';

import { AppError } from '../middleware/errorHandler.js';
import Enterprise from '../models/Enterprise.js';
import Subscription from '../models/Subscription.js';
import { getSettings } from '../models/SystemSettings.js';
import Transaction from '../models/Transaction.js';
import User from '../models/User.js';
import Plan from '../models/Plan.js';
import {
  enterpriseTermTotalPaise,
  getBillingCatalogFromSettings,
  subscriptionPayableForMonths,
} from '../services/billingCatalogService.js';
import { sendPaymentSuccessEmail } from '../services/emailService.js';
import { getEnterpriseBillingBreakdown } from '../services/enterpriseBillingService.js';
import {
  addMonthsClamped,
  buildEnterpriseRenewalTimeline,
  buildEnterpriseSnapshot,
  buildPersonalRenewalTimeline,
  enqueueEnterpriseRenewal,
  enqueuePersonalRenewal,
  enterpriseSubscriptionIsActive,
  processPersonalSubscriptionLifecycle,
} from '../services/subscriptionLifecycleService.js';
import {
  computeExamUsageSnapshot,
  computeExamUsageSnapshotWithEnterprise,
  getMaxQuestionsForUser,
  hasActivePaidPlanForCredits,
} from '../services/subscriptionUsageService.js';
import {
  effectivePlanType,
  filterUpgradeEligiblePlans,
  getUserPlanLimits,
  resolveAutoPayTargetPlan,
  resolveBillingPlanContext,
  resolveCurrentIndividualPlan,
} from '../services/userPlanLimitsService.js';
import { fromReq, log } from '../utils/activityLogger.js';
import logger from '../utils/logger.js';
import { createNotificationsForUsers } from './notificationController.js';

/** Per-teacher AI exam usage for organization principals (calendar month). */
async function buildPrincipalTeacherExamUsage(enterpriseId, entLean) {
  const examCap = entLean?.examsPerTeacherLimit ?? 30;
  const teachers = await User.find({ enterpriseId, role: 'instructor' })
    .select('name email')
    .sort({ name: 1 })
    .lean();
  const rows = [];
  let totalUsed = 0;
  let totalCap = 0;
  for (const t of teachers) {
    const snap = await computeExamUsageSnapshot(t._id, examCap, { skipLifecycle: true });
    if (!snap) continue;
    totalUsed += snap.usedThisMonth;
    totalCap += snap.totalCap;
    rows.push({
      id: String(t._id),
      name: t.name || 'Teacher',
      email: t.email || '',
      usedThisMonth: snap.usedThisMonth,
      monthlyCap: snap.totalCap,
      remaining: snap.remaining,
    });
  }
  return {
    teachers: rows,
    aggregate: {
      activeTeachers: rows.length,
      examsUsedThisMonth: totalUsed,
      totalMonthlyAllocation: totalCap,
      remainingCombined: Math.max(0, totalCap - totalUsed),
      utilizationPct: totalCap > 0 ? Math.min(100, Math.round((totalUsed / totalCap) * 100)) : 0,
    },
  };
}

let _rzp = null;
const getRzp = () => {
  if (!_rzp) {
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      throw new Error('Razorpay keys not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env');
    }
    _rzp = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
  }
  return _rzp;
};

export const PLAN_PRICES = {
  pro: { amount: 14900, label: '₹149/month', name: 'Premium' },
};

const getEffectivePlanPrices = async () => {
  try {
    const settings = await getSettings();
    return {
      pro: {
        amount: settings.planPricePro || 14900,
        name: 'Premium',
        label: `₹${Math.round((settings.planPricePro || 14900) / 100)}/month`,
      },
    };
  } catch {
    return PLAN_PRICES;
  }
};

const AUTOPAY_SUPPORTED_PERSONAL_PLAN = 'pro';
const PLAN_RANK = { free: 0, pro: 1, enterprise: 2 };

const isInstructorLike = (user) => ['instructor', 'admin', 'principal'].includes(user?.role);

function getPersonalPlanMonthlyPrice(settings, plan) {
  if (plan === 'enterprise') return Math.max(100, Number(settings.planPriceEnterprise || 199900));
  return Math.max(100, Number(settings.planPricePro || 14900));
}

function getDurationDiscountPercent(catalog, months) {
  const row = (catalog?.durations || []).find((d) => Number(d.months) === Number(months));
  return Math.max(0, Number(row?.discountPercent || 0));
}

function computePersonalPlanPayablePaise(settings, catalog, plan, months) {
  const monthly = getPersonalPlanMonthlyPrice(settings, plan);
  const discountPercent = getDurationDiscountPercent(catalog, months);
  const listTotalPaise = monthly * months;
  const payableTotalPaise = Math.max(100, Math.round(listTotalPaise * ((100 - discountPercent) / 100)));
  return { monthlyPricePaise: monthly, listTotalPaise, discountPercent, payableTotalPaise };
}

function computeProratedUpgradeCreditPaise({ user, amountPaidPaise, totalCycleDays }) {
  if (!user?.planExpiresAt || !['pro', 'enterprise'].includes(user.plan)) return 0;
  const now = new Date();
  const expiry = new Date(user.planExpiresAt);
  if (expiry <= now) return 0;
  const baseAmount = Math.max(0, Number(amountPaidPaise || 0));
  if (baseAmount < 1) return 0;
  const normalizedCycleDays = Math.max(1, Math.round(Number(totalCycleDays || 30)));
  const remainingDays = Math.max(0, Math.ceil((expiry.getTime() - now.getTime()) / 86400000));
  return Math.max(0, Math.min(baseAmount, Math.round(baseAmount * (remainingDays / normalizedCycleDays))));
}

async function resolveCurrentPlanProrationBasis(user) {
  const now = new Date();
  const activeSub = await Subscription.findOne({
    user: user._id,
    plan: user.plan,
    status: { $in: ['active', 'pending', 'payment_pending', 'grace_period'] },
  })
    .select('amountPaid startDate endDate durationMonths')
    .sort({ endDate: -1, updatedAt: -1 });

  if (activeSub) {
    const totalDaysByDates = activeSub.startDate && activeSub.endDate
      ? Math.ceil((new Date(activeSub.endDate).getTime() - new Date(activeSub.startDate).getTime()) / 86400000)
      : 0;
    const totalDays = Math.max(1, totalDaysByDates || (Math.max(1, Number(activeSub.durationMonths || 1)) * 30));
    const remainingDays = user.planExpiresAt
      ? Math.max(0, Math.ceil((new Date(user.planExpiresAt).getTime() - now.getTime()) / 86400000))
      : 0;
    return {
      amountPaidPaise: Math.max(0, Number(activeSub.amountPaid || 0)),
      totalCycleDays: totalDays,
      remainingDays,
    };
  }

  const lastPaidTxn = await Transaction.findOne({
    user: user._id,
    purchaseType: 'subscription',
    plan: user.plan,
    status: 'paid',
    $or: [{ billingScope: 'personal' }, { billingScope: { $exists: false } }],
  })
    .select('amount durationMonths')
    .sort({ createdAt: -1 });

  if (lastPaidTxn) {
    const totalDays = Math.max(1, Math.round(Number(lastPaidTxn.durationMonths || 1)) * 30);
    const remainingDays = user.planExpiresAt
      ? Math.max(0, Math.ceil((new Date(user.planExpiresAt).getTime() - now.getTime()) / 86400000))
      : 0;
    return {
      amountPaidPaise: Math.max(0, Number(lastPaidTxn.amount || 0)),
      totalCycleDays: totalDays,
      remainingDays,
    };
  }

  return { amountPaidPaise: 0, totalCycleDays: 30, remainingDays: 0 };
}

async function ensureRazorpayMonthlyPlan(settings, amountPaise, planKey = 'pro') {
  const rzp = getRzp();
  const useEnterprise = planKey === 'enterprise';
  const useLegacyCache = planKey === 'pro' || planKey === 'enterprise';

  if (useLegacyCache) {
    const cachedId = useEnterprise
      ? settings.razorpayAutopayPlanIdEnterpriseMonthly
      : settings.razorpayAutopayPlanIdProMonthly;
    const cachedAmt = Number(useEnterprise
      ? settings.razorpayAutopayPlanAmountEnterpriseMonthly
      : settings.razorpayAutopayPlanAmountProMonthly || 0);
    if (cachedId && cachedAmt === amountPaise) return cachedId;
  }

  const displayName = useEnterprise
    ? 'Enterprise'
    : String(planKey || 'premium').replace(/^\w/, (c) => c.toUpperCase());

  const plan = await rzp.plans.create({
    period: 'monthly',
    interval: 1,
    item: {
      name: `LikhitAI ${displayName} Monthly AutoPay`,
      amount: amountPaise,
      currency: 'INR',
      description: `Recurring monthly ${displayName} subscription`,
    },
    notes: { app: 'likhitai', planCode: planKey, billing: 'monthly' },
  });

  if (useLegacyCache) {
    if (useEnterprise) {
      settings.razorpayAutopayPlanIdEnterpriseMonthly = plan.id;
      settings.razorpayAutopayPlanAmountEnterpriseMonthly = amountPaise;
      settings.razorpayAutopayPlanCurrencyEnterpriseMonthly = 'INR';
    } else {
      settings.razorpayAutopayPlanIdProMonthly = plan.id;
      settings.razorpayAutopayPlanAmountProMonthly = amountPaise;
      settings.razorpayAutopayPlanCurrencyProMonthly = 'INR';
    }
    await settings.save();
  }
  return plan.id;
}

function getWebhookBody(req) {
  if (req.rawBody && typeof req.rawBody === 'string') return req.rawBody;
  try {
    return JSON.stringify(req.body || {});
  } catch {
    return '';
  }
}

async function upsertSubscriptionForRecurring({
  user,
  plan = 'pro',
  individualPlanCode = '',
  amountPaid,
  durationMonths = 1,
  startDate,
  endDate,
  razorpaySubscriptionId,
  razorpayPaymentId = '',
  razorpayOrderId = '',
  status = 'active',
  autoRenewEnabled = true,
  subscriptionStatus = 'active',
  nextBillingDate = null,
  lastBillingDate = null,
  paymentMethod = '',
  gracePeriodEndsAt = null,
  latestInvoiceId = '',
  latestInvoiceUrl = '',
}) {
  const sub = await Subscription.findOneAndUpdate(
    { user: user._id, plan, provider: 'razorpay', razorpaySubscriptionId },
    {
      user: user._id,
      plan,
      individualPlanCode: individualPlanCode || user.individualPlanCode || '',
      provider: 'razorpay',
      status,
      amountPaid,
      durationMonths,
      billingCycle: 'monthly',
      startDate,
      endDate,
      razorpaySubscriptionId,
      razorpayPaymentId: razorpayPaymentId || undefined,
      razorpayOrderId: razorpayOrderId || undefined,
      autoRenewEnabled,
      subscriptionStatus,
      nextBillingDate,
      lastBillingDate,
      paymentMethod,
      gracePeriodEndsAt,
      latestInvoiceId,
      latestInvoiceUrl,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return sub;
}

/** POST /api/payments/create-order */
export const createOrder = async (req, res, next) => {
  try {
    const body = req.body || {};
    const purchaseType = body.purchaseType === 'exam_credits' ? 'exam_credits' : 'subscription';
    const catalog = await getBillingCatalogFromSettings();

    let rzp;
    try {
      rzp = getRzp();
    } catch {
      return next(new AppError('Payment system is not configured. Please contact support.', 503));
    }

    let amount;
    let planField;
    let durationMonths;
    let examCreditQuantity;
    let receiptSuffix;

    let billingScope = 'personal';
    let enterpriseRef = null;

    if (purchaseType === 'exam_credits') {
      const qty = Math.floor(Number(body.quantity));
      if (!Number.isFinite(qty) || qty < 1 || qty > 500) {
        return next(new AppError('Choose between 1 and 500 additional exams.', 400));
      }
      const user = await User.findById(req.user._id);
      if (!user) return next(new AppError('User not found', 404));
      if (!(await hasActivePaidPlanForCredits(user))) {
        return next(new AppError('Additional exam credits require an active paid or organization plan.', 403));
      }
      amount = Math.round(qty * catalog.additionalExamCreditPricePaise);
      if (amount < 100) return next(new AppError('Invalid payment amount.', 400));
      planField = 'exam_credits';
      examCreditQuantity = qty;
      receiptSuffix = `xc_${qty}`;
    } else {
      billingScope = body.billingScope === 'enterprise' ? 'enterprise' : 'personal';
      durationMonths = [1, 3, 6].includes(Number(body.durationMonths)) ? Number(body.durationMonths) : 1;
      const payable = subscriptionPayableForMonths(durationMonths, catalog);
      if (!payable) return next(new AppError('Invalid subscription duration.', 400));

      if (billingScope === 'enterprise') {
        const ent = await Enterprise.findById(body.enterpriseId);
        if (!ent) return next(new AppError('Organization not found.', 404));
        if (ent.principalUser.toString() !== req.user._id.toString()) {
          return next(new AppError('Only the organization owner can purchase this plan.', 403));
        }
        const monthlyBase = (ent.estimatedMonthlyCostManualPaise != null && Number(ent.estimatedMonthlyCostManualPaise) >= 100)
          ? Math.round(Number(ent.estimatedMonthlyCostManualPaise))
          : Math.round(Number(ent.estimatedMonthlyCost) || 0);
        const entAmount = enterpriseTermTotalPaise(monthlyBase, durationMonths);
        if (!entAmount) return next(new AppError('Could not compute organization checkout amount.', 400));
        amount = entAmount;
        planField = 'enterprise';
        enterpriseRef = ent._id;
        receiptSuffix = `ent_${durationMonths}m`;
      } else {
        const requestedPlan = String(body.plan || '').trim().toLowerCase();
        const dynamicPlan = await Plan.findOne({ code: requestedPlan, isActive: true, audience: 'individual' })
          .select('code pricing')
          .lean();
        const plan = requestedPlan === 'enterprise' ? 'enterprise' : 'pro';
        if (!dynamicPlan && !['pro', 'enterprise'].includes(requestedPlan)) return next(new AppError('Invalid plan', 400));
        const user = await User.findById(req.user._id).select('plan planExpiresAt autoRenew razorpaySubscriptionId subscriptionStatus');
        if (user?.autoRenew && user?.razorpaySubscriptionId) {
          return next(new AppError(
            'AutoPay is enabled on your account. Disable AutoPay to use manual queued renewals.',
            409,
          ));
        }
        const settings = await getSettings();
        const pricing = dynamicPlan
          ? {
            payableTotalPaise: Math.max(
              100,
              Number(
                durationMonths === 6
                  ? (dynamicPlan.pricing?.halfYearlyPricePaise ?? dynamicPlan.pricing?.monthlyPricePaise * 6)
                  : durationMonths === 3
                    ? (dynamicPlan.pricing?.quarterlyPricePaise ?? dynamicPlan.pricing?.monthlyPricePaise * 3)
                    : dynamicPlan.pricing?.monthlyPricePaise,
              ) || 0,
            ),
          }
          : computePersonalPlanPayablePaise(settings, catalog, plan, durationMonths);
        amount = pricing.payableTotalPaise;
        const upgrade = body.upgrade || {};
        if (
          PLAN_RANK[plan] > PLAN_RANK[user?.plan || 'free']
          && Number(upgrade.creditAppliedPaise) > 0
        ) {
          const prorationBasis = await resolveCurrentPlanProrationBasis(user);
          const maxCredit = computeProratedUpgradeCreditPaise({
            user,
            amountPaidPaise: prorationBasis.amountPaidPaise,
            totalCycleDays: prorationBasis.totalCycleDays,
          });
          const requestedCredit = Math.max(0, Number(upgrade.creditAppliedPaise || 0));
          const appliedCredit = Math.min(maxCredit, requestedCredit, amount - 100);
          amount = Math.max(100, amount - appliedCredit);
        }
        planField = plan;
        receiptSuffix = `sub_${plan}_${durationMonths}m`;
        body.individualPlanCode = dynamicPlan?.code || (plan === 'pro' ? 'premium' : '');
      }
    }

    const receipt = `rcpt_${req.user._id.toString().slice(-8)}_${Date.now().toString().slice(-8)}_${receiptSuffix}`.slice(0, 40);

    let order;
    try {
      order = await rzp.orders.create({ amount, currency: 'INR', receipt });
    } catch (rzpErr) {
      logger.error('Razorpay order creation failed:', rzpErr.message);
      return next(new AppError('Failed to create payment order. Please try again or contact support.', 502));
    }

    try {
      await Transaction.create({
        user: req.user._id,
        billingScope,
        enterprise: enterpriseRef,
        razorpayOrderId: order.id,
        amount,
        plan: planField,
        purchaseType: purchaseType === 'exam_credits' ? 'exam_credits' : 'subscription',
        durationMonths: purchaseType === 'exam_credits' ? undefined : durationMonths,
        examCreditQuantity: purchaseType === 'exam_credits' ? examCreditQuantity : undefined,
        receipt,
        status: 'created',
        metadata: purchaseType === 'subscription' && billingScope === 'personal' ? {
          source: 'manual',
          targetPlan: planField,
          individualPlanCode: body?.individualPlanCode || '',
          requestedDurationMonths: durationMonths,
          creditAppliedPaise: Math.max(0, Number(body?.upgrade?.creditAppliedPaise || 0)),
        } : null,
      });
    } catch (txnErr) {
      logger.warn('Transaction record creation skipped:', txnErr.message);
    }

    res.json({
      orderId: order.id,
      amount,
      currency: 'INR',
      keyId: process.env.RAZORPAY_KEY_ID,
      purchaseType,
      durationMonths: purchaseType === 'subscription' ? durationMonths : undefined,
      billingScope: purchaseType === 'subscription' ? billingScope : undefined,
      enterpriseId: purchaseType === 'subscription' && billingScope === 'enterprise' ? enterpriseRef?.toString() : undefined,
      examCreditQuantity: purchaseType === 'exam_credits' ? examCreditQuantity : undefined,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Create Razorpay subscription checkout for the user's current active catalog plan.
 * Mandate approval still happens in Razorpay UI; autoRenew flips true after enableAutoRenew.
 */
async function buildAutoPayCheckoutForUser(user, { requestedPlanCode = '' } = {}) {
  if (!user || !isInstructorLike(user)) return null;
  if (effectivePlanType(user) === 'free') return null;

  const targetPlanDoc = await resolveAutoPayTargetPlan(user, requestedPlanCode);
  if (!targetPlanDoc?.pricing?.monthlyPricePaise) return null;

  const settings = await getSettings();
  const rzp = getRzp();
  const planCode = targetPlanDoc.code;
  const amount = Math.max(100, Math.round(Number(targetPlanDoc.pricing.monthlyPricePaise) || 0));

  if (user.razorpaySubscriptionId) {
    try {
      await rzp.subscriptions.cancel(user.razorpaySubscriptionId, { cancel_at_cycle_end: 0 });
    } catch (e) {
      logger.warn(`autopay replace cancel old failed ${user.razorpaySubscriptionId}: ${e.message}`);
    }
  }

  const razorpayPlanId = await ensureRazorpayMonthlyPlan(settings, amount, planCode);
  const subscription = await rzp.subscriptions.create({
    plan_id: razorpayPlanId,
    customer_notify: 1,
    total_count: 120,
    quantity: 1,
    notes: {
      userId: String(user._id),
      source: 'likhitai_autopay',
      individualPlanCode: planCode,
    },
  });

  const initialNextBilling = extractNextBillingDateFromRazorpaySub(subscription, user);

  await upsertSubscriptionForRecurring({
    user,
    plan: 'pro',
    individualPlanCode: planCode,
    amountPaid: amount,
    durationMonths: 1,
    startDate: new Date(),
    endDate: user.planExpiresAt && user.planExpiresAt > new Date() ? user.planExpiresAt : new Date(),
    razorpaySubscriptionId: subscription.id,
    status: 'pending',
    autoRenewEnabled: false,
    subscriptionStatus: subscription.status || 'created',
    nextBillingDate: initialNextBilling,
  });

  user.plan = 'pro';
  user.individualPlanCode = planCode;
  user.autoRenew = false;
  user.autoRenewProvider = 'razorpay';
  user.razorpaySubscriptionId = subscription.id;
  user.subscriptionStatus = subscription.status || 'created';
  user.nextBillingDate = initialNextBilling;
  await user.save({ validateBeforeSave: false });

  return {
    keyId: process.env.RAZORPAY_KEY_ID,
    subscriptionId: subscription.id,
    planCode,
    status: subscription.status,
    nextBillingDate: initialNextBilling,
  };
}

/** POST /api/payments/create-subscription */
export const createSubscriptionCheckout = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return next(new AppError('User not found', 404));
    if (!isInstructorLike(user)) return next(new AppError('AutoPay is available for instructor accounts only.', 403));
    if (effectivePlanType(user) === 'free') {
      return next(new AppError('AutoPay requires an active paid plan. Upgrade first, then enable AutoPay.', 403));
    }

    const { plan: requestedPlan } = req.body || {};
    let checkout;
    try {
      checkout = await buildAutoPayCheckoutForUser(user, { requestedPlanCode: requestedPlan });
    } catch {
      return next(new AppError('Payment system is not configured. Please contact support.', 503));
    }
    if (!checkout) {
      return next(new AppError('Could not resolve your active plan for AutoPay. Contact support.', 400));
    }

    res.json({
      keyId: checkout.keyId,
      subscriptionId: checkout.subscriptionId,
      status: checkout.status,
      autoRenewEnabled: false,
      nextBillingDate: checkout.nextBillingDate,
      message: 'Approve mandate to enable automatic monthly renewal.',
    });
  } catch (err) {
    const rzpMsg = err?.error?.description || err?.description || err?.message;
    logger.error('createSubscriptionCheckout failed:', rzpMsg || err);
    if (rzpMsg?.includes('not configured') || err?.message?.includes('not configured')) {
      return next(new AppError('Payment system is not configured. Please contact support.', 503));
    }
    if (err?.statusCode) {
      return next(new AppError(rzpMsg || 'Could not start AutoPay checkout.', 502));
    }
    next(err);
  }
};

async function finalizePaidTransaction(txn, paymentIds) {
  const now = new Date();
  const user = await User.findById(txn.user);
  if (!user) throw new Error('User missing for paid transaction');

  if (txn.purchaseType === 'exam_credits') {
    const qty = Math.floor(Number(txn.examCreditQuantity) || 0);
    if (qty < 1) throw new Error('Invalid exam credit quantity on transaction');
    if (!(await hasActivePaidPlanForCredits(user))) {
      throw new Error('Cannot apply exam credits without an active paid or organization plan');
    }
    await User.findByIdAndUpdate(user._id, { $inc: { extraExamCreditsBalance: qty } });
    return User.findById(user._id);
  }

  const plan = ['pro', 'enterprise'].includes(txn.plan) ? txn.plan : null;
  if (!plan) throw new Error('Invalid subscription plan on transaction');
  const months = [1, 3, 6].includes(Number(txn.durationMonths)) ? Number(txn.durationMonths) : 1;

  const billingScope = txn.billingScope || 'personal';

  if (billingScope === 'enterprise' && txn.enterprise) {
    const ent = await Enterprise.findById(txn.enterprise);
    if (!ent || ent.principalUser.toString() !== user._id.toString()) {
      throw new Error('Invalid organization billing context');
    }

    // Queue only when a *paid* org term is already active. Org trial alone must not send the first payment to the queue.
    const orgPaidWindow = !!(ent.orgPlanExpiresAt && ent.orgPlanExpiresAt > now);
    if (orgPaidWindow) {
      await enqueueEnterpriseRenewal(ent._id, {
        durationMonths: months,
        plan: 'enterprise',
        activatesAt: now,
        razorpayOrderId: txn.razorpayOrderId,
        transactionId: txn._id,
        snapshot: buildEnterpriseSnapshot(ent),
      });
      const queuedEnd = addMonthsClamped(
        ent.orgPlanExpiresAt && ent.orgPlanExpiresAt > now ? ent.orgPlanExpiresAt : now,
        months,
      );
      const sub = await Subscription.findOneAndUpdate(
        { razorpayOrderId: txn.razorpayOrderId },
        {
          user: user._id,
          plan: 'enterprise',
          status: 'pending',
          razorpayOrderId: txn.razorpayOrderId,
          razorpayPaymentId: paymentIds.razorpay_payment_id,
          razorpaySignature: paymentIds.razorpay_signature,
          amountPaid: txn.amount,
          startDate: now,
          endDate: queuedEnd,
          billingCycle: months === 1 ? 'monthly' : 'multi',
          durationMonths: months,
        },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      );
      await Transaction.findByIdAndUpdate(txn._id, { subscription: sub._id });
      return User.findById(user._id);
    }

    let anchor = now;
    if (ent.orgPlanExpiresAt && ent.orgPlanExpiresAt > now) anchor = ent.orgPlanExpiresAt;
    else if (ent.orgTrialEndsAt && ent.orgTrialEndsAt > now) anchor = ent.orgTrialEndsAt;
    ent.orgPlanExpiresAt = addMonthsClamped(anchor <= now ? now : anchor, months);
    ent.orgPlanStartedAt = now;
    ent.orgPlanDurationMonths = months;
    ent.orgPlanActive = true;
    ent.orgTrialEndsAt = null;
    await ent.save();

    const sub = await Subscription.findOneAndUpdate(
      { razorpayOrderId: txn.razorpayOrderId },
      {
        user: user._id,
        plan: 'enterprise',
        status: 'active',
        razorpayOrderId: txn.razorpayOrderId,
        razorpayPaymentId: paymentIds.razorpay_payment_id,
        razorpaySignature: paymentIds.razorpay_signature,
        amountPaid: txn.amount,
        startDate: now,
        endDate: ent.orgPlanExpiresAt,
        billingCycle: months === 1 ? 'monthly' : 'multi',
        durationMonths: months,
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );

    user.plan = 'enterprise';
    user.planExpiresAt = ent.orgPlanExpiresAt;
    user.examsCreatedThisMonth = 0;
    user.monthlyExamResetDate = now;
    await user.save({ validateBeforeSave: false });

    await Transaction.findByIdAndUpdate(txn._id, { subscription: sub._id });
    return User.findById(user._id);
  }

  const trialActive = !!(user.instructorTrialEndsAt && user.instructorTrialEndsAt > now);
  const paidWindow = !!(user.planExpiresAt && user.planExpiresAt > now && (user.plan === 'pro' || user.plan === 'enterprise'));
  const priorPaidPersonalSubscriptions = await Transaction.countDocuments({
    user: user._id,
    status: 'paid',
    purchaseType: 'subscription',
    _id: { $ne: txn._id },
    $or: [{ billingScope: 'personal' }, { billingScope: { $exists: false } }],
  });
  const shouldQueuePersonal = !trialActive && paidWindow && txn.plan === user.plan && priorPaidPersonalSubscriptions > 0;

  if (shouldQueuePersonal) {
    await enqueuePersonalRenewal(user._id, {
      durationMonths: months,
      plan,
      activatesAt: now,
      razorpayOrderId: txn.razorpayOrderId,
      transactionId: txn._id,
    });
    const queuedEnd = addMonthsClamped(user.planExpiresAt, months);
    const sub = await Subscription.findOneAndUpdate(
      { razorpayOrderId: txn.razorpayOrderId },
      {
        user: user._id,
        plan,
        status: 'pending',
        razorpayOrderId: txn.razorpayOrderId,
        razorpayPaymentId: paymentIds.razorpay_payment_id,
        razorpaySignature: paymentIds.razorpay_signature,
        amountPaid: txn.amount,
        startDate: now,
        endDate: queuedEnd,
        billingCycle: months === 1 ? 'monthly' : 'multi',
        durationMonths: months,
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    await Transaction.findByIdAndUpdate(txn._id, { subscription: sub._id });
    return User.findById(user._id);
  }

  if (trialActive) {
    user.instructorTrialEndsAt = null;
  }
  const anchor = (!trialActive && user.plan === plan && user.planExpiresAt && user.planExpiresAt > now)
    ? user.planExpiresAt
    : now;
  const endDate = addMonthsClamped(anchor, months);

  const sub = await Subscription.findOneAndUpdate(
    { razorpayOrderId: txn.razorpayOrderId },
    {
      user: user._id,
      plan,
      status: 'active',
      razorpayOrderId: txn.razorpayOrderId,
      razorpayPaymentId: paymentIds.razorpay_payment_id,
      razorpaySignature: paymentIds.razorpay_signature,
      amountPaid: txn.amount,
      startDate: now,
      endDate,
      billingCycle: months === 1 ? 'monthly' : 'multi',
      durationMonths: months,
      individualPlanCode: String(txn?.metadata?.individualPlanCode || user?.individualPlanCode || 'premium'),
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );

  user.plan = plan;
  if (plan === 'pro') user.individualPlanCode = String(txn?.metadata?.individualPlanCode || user.individualPlanCode || 'premium');
  user.planExpiresAt = endDate;
  user.examsCreatedThisMonth = 0;
  user.monthlyExamResetDate = now;
  await user.save({ validateBeforeSave: false });

  await Transaction.findByIdAndUpdate(txn._id, { subscription: sub._id });
  return User.findById(user._id);
}
/** POST /api/payments/verify */
export const verifyPayment = async (req, res, next) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return next(new AppError('Missing required payment fields', 400));
    }
    if (!process.env.RAZORPAY_KEY_SECRET) {
      return next(new AppError('Payment system is not configured. Please contact support.', 503));
    }

    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expected !== razorpay_signature) {
      return next(new AppError('Payment verification failed. Please contact support if amount was deducted.', 400));
    }

    const txn = await Transaction.findOne({ razorpayOrderId: razorpay_order_id });
    if (!txn) return next(new AppError('Order not found. Please start checkout again.', 404));
    if (txn.user.toString() !== req.user._id.toString()) {
      return next(new AppError('This payment does not belong to your account.', 403));
    }

    if (txn.status === 'paid') {
      const userFresh = await User.findById(req.user._id);
      const snap = await computeExamUsageSnapshotWithEnterprise(userFresh);
      return res.json({
        success: true,
        alreadyProcessed: true,
        plan: userFresh.plan,
        planExpiresAt: userFresh.planExpiresAt,
        remaining: snap?.remaining ?? 0,
        extraExamCreditsBalance: userFresh.extraExamCreditsBalance || 0,
        examsTotalCap: snap?.totalCap ?? 0,
      });
    }

    if (txn.amount < 100) return next(new AppError('Invalid stored order amount.', 400));

    const txnUpdated = await Transaction.findOneAndUpdate(
      { razorpayOrderId: razorpay_order_id, status: 'created' },
      { razorpayPaymentId: razorpay_payment_id, status: 'paid' },
      { new: true },
    );
    if (!txnUpdated) {
      const again = await Transaction.findOne({ razorpayOrderId: razorpay_order_id });
      if (again?.status === 'paid') {
        const userFresh = await User.findById(req.user._id);
        const snap = await computeExamUsageSnapshotWithEnterprise(userFresh);
        return res.json({
          success: true,
          alreadyProcessed: true,
          plan: userFresh.plan,
          planExpiresAt: userFresh.planExpiresAt,
          remaining: snap?.remaining ?? 0,
          extraExamCreditsBalance: userFresh.extraExamCreditsBalance || 0,
          examsTotalCap: snap?.totalCap ?? 0,
        });
      }
      return next(new AppError('This order was already processed or cancelled.', 409));
    }

    let updatedUser;
    try {
      updatedUser = await finalizePaidTransaction(txnUpdated, {
        razorpay_payment_id,
        razorpay_signature,
      });
    } catch (e) {
      logger.error('finalizePaidTransaction:', e.message);
      await Transaction.findOneAndUpdate(
        { razorpayOrderId: razorpay_order_id },
        { status: 'created', razorpayPaymentId: null },
      );
      return next(new AppError(e.message || 'Could not finalize payment.', 500));
    }

    await log({
      user: req.user,
      action: txnUpdated.purchaseType === 'exam_credits' ? 'exam_credits_purchased' : 'plan_upgraded',
      category: 'profile',
      metadata: {
        purchaseType: txnUpdated.purchaseType,
        orderId: razorpay_order_id,
        paymentId: razorpay_payment_id,
        durationMonths: txnUpdated.durationMonths,
        examCreditQuantity: txnUpdated.examCreditQuantity,
      },
      ...fromReq(req),
      severity: 'info',
    });

    const settings = await getSettings();
    if (settings.emailPlanUpgradeEnabled && txnUpdated.purchaseType !== 'exam_credits') {
      const effectivePrices = await getEffectivePlanPrices();
      const planKey = txnUpdated.plan === 'pro' ? 'pro' : 'pro';
      sendPaymentSuccessEmail({
        email: updatedUser.email,
        name: updatedUser.name,
        plan: effectivePrices[planKey].name,
        amount: `₹${(txnUpdated.amount / 100).toFixed(0)}`,
        expiresAt: (updatedUser.planExpiresAt
          ? updatedUser.planExpiresAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
          : '—'),
      }).catch(logger.error);
    }

    const snap = await computeExamUsageSnapshotWithEnterprise(updatedUser);
    let autoPayCheckout = null;
    const isPersonalSubscription = txnUpdated.purchaseType === 'subscription'
      && (txnUpdated.billingScope || 'personal') === 'personal';
    if (isPersonalSubscription && isInstructorLike(updatedUser)) {
      try {
        const freshUser = await User.findById(updatedUser._id);
        autoPayCheckout = await buildAutoPayCheckoutForUser(freshUser);
      } catch (e) {
        logger.warn('AutoPay setup after purchase failed:', e?.message || e);
      }
    }

    res.json({
      success: true,
      plan: updatedUser.plan,
      planExpiresAt: updatedUser.planExpiresAt,
      remaining: snap?.remaining ?? 0,
      extraExamCreditsBalance: updatedUser.extraExamCreditsBalance || 0,
      examsTotalCap: snap?.totalCap ?? 0,
      ...(autoPayCheckout ? { autoPayCheckout } : {}),
    });
  } catch (err) {
    next(err);
  }
};

/** POST /api/payments/autopay/enable */
export const enableAutoRenew = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return next(new AppError('User not found', 404));
    if (!isInstructorLike(user)) return next(new AppError('Only instructor accounts can enable AutoPay.', 403));

    const subscriptionId = String(req.body?.razorpaySubscriptionId || user.razorpaySubscriptionId || '').trim();
    if (!subscriptionId) {
      return next(new AppError('No Razorpay subscription linked. Create AutoPay checkout first.', 400));
    }

    user.autoRenew = true;
    user.autoRenewProvider = 'razorpay';
    user.razorpaySubscriptionId = subscriptionId;
    await user.save({ validateBeforeSave: false });

    await Subscription.updateMany(
      { user: user._id, razorpaySubscriptionId: subscriptionId },
      { $set: { autoRenewEnabled: true } },
    );

    const synced = await syncRazorpaySubscriptionState(user);
    const fresh = await User.findById(user._id).select(
      'nextBillingDate lastBillingDate subscriptionStatus autoRenew subscriptionPaymentMethod',
    );

    await createNotificationsForUsers([user._id], {
      type: 'general',
      title: 'AutoPay enabled',
      message: fresh?.nextBillingDate
        ? `Your subscription will renew automatically. Next payment on ${fresh.nextBillingDate.toLocaleDateString('en-IN')}.`
        : 'Your subscription will renew automatically through Razorpay.',
      severity: 'success',
    });

    res.json({
      success: true,
      autoRenewEnabled: true,
      subscriptionId,
      nextBillingDate: synced?.nextBillingDate || fresh?.nextBillingDate || null,
      lastBillingDate: synced?.lastBillingDate || fresh?.lastBillingDate || null,
      subscriptionStatus: synced?.subscriptionStatus || fresh?.subscriptionStatus || '',
      paymentMethod: fresh?.subscriptionPaymentMethod || '',
    });
  } catch (err) {
    next(err);
  }
};

/** POST /api/payments/autopay/disable */
export const disableAutoRenew = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return next(new AppError('User not found', 404));
    const subscriptionId = String(req.body?.razorpaySubscriptionId || user.razorpaySubscriptionId || '').trim();
    if (!subscriptionId) {
      // Backward-compatible recovery path: clear stale local auto-renew state.
      user.autoRenew = false;
      user.autoRenewProvider = '';
      user.subscriptionStatus = user.subscriptionStatus === 'payment_failed' ? 'payment_failed' : 'manual';
      user.nextBillingDate = null;
      user.razorpaySubscriptionId = '';
      await user.save({ validateBeforeSave: false });
      await Subscription.updateMany(
        { user: user._id, autoRenewEnabled: true },
        { $set: { autoRenewEnabled: false, subscriptionStatus: 'manual' } },
      );

      await createNotificationsForUsers([user._id], {
        type: 'general',
        title: 'AutoPay disabled',
        message: 'AutoPay is now disabled for your account.',
        severity: 'info',
      });
      return res.json({
        success: true,
        autoRenewEnabled: false,
        recovered: true,
        message: 'AutoPay was disabled and stale subscription linkage was cleaned up.',
      });
    }

    const rzp = getRzp();
    try {
      await rzp.subscriptions.cancel(subscriptionId, { cancel_at_cycle_end: 1 });
    } catch (e) {
      logger.warn(`disableAutoRenew cancel failed ${subscriptionId}: ${e.message}`);
    }

    user.autoRenew = false;
    user.autoRenewProvider = '';
    user.razorpaySubscriptionId = '';
    user.nextBillingDate = null;
    user.subscriptionStatus = 'cancel_at_cycle_end';
    await user.save({ validateBeforeSave: false });
    await Subscription.updateMany(
      { user: user._id, razorpaySubscriptionId: subscriptionId },
      { $set: { autoRenewEnabled: false, subscriptionStatus: 'cancel_at_cycle_end' } },
    );

    await createNotificationsForUsers([user._id], {
      type: 'general',
      title: 'AutoPay disabled',
      message: 'Future recurring charges are cancelled. Your current plan remains active until expiry.',
      severity: 'info',
    });

    res.json({ success: true, autoRenewEnabled: false, cancelledAtCycleEnd: true });
  } catch (err) {
    next(err);
  }
};

/** POST /api/payments/autopay/cancel */
export const cancelAutoRenew = disableAutoRenew;

/** GET /api/payments/autopay/management */
export const getSubscriptionManagementPortal = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select('razorpaySubscriptionId autoRenew');
    if (!user?.razorpaySubscriptionId) return res.json({ manageUrl: null });
    // Razorpay supports customer-facing links via dashboard integrations; keep a direct subscription hint.
    const dashboardUrl = `https://dashboard.razorpay.com/app/subscriptions/${user.razorpaySubscriptionId}`;
    res.json({ manageUrl: dashboardUrl, autoRenewEnabled: user.autoRenew });
  } catch (err) {
    next(err);
  }
};

/** Resolve next charge date from Razorpay subscription payload (fields vary by status). */
function extractNextBillingDateFromRazorpaySub(rzSub, user) {
  const epochCandidates = [
    rzSub?.current_end,
    rzSub?.charge_at,
    rzSub?.end_at,
  ].filter((v) => v != null && Number(v) > 0);

  for (const ts of epochCandidates) {
    const d = new Date(Number(ts) * 1000);
    if (!Number.isNaN(d.getTime())) return d;
  }

  if (rzSub?.current_start) {
    const start = new Date(Number(rzSub.current_start) * 1000);
    if (!Number.isNaN(start.getTime())) return addMonthsClamped(start, 1);
  }

  if (user?.planExpiresAt) {
    const exp = new Date(user.planExpiresAt);
    if (!Number.isNaN(exp.getTime()) && exp > new Date()) return exp;
  }

  return null;
}

async function syncRazorpaySubscriptionState(user, subscriptionDoc) {
  const subscriptionId = user?.razorpaySubscriptionId || subscriptionDoc?.razorpaySubscriptionId;
  if (!subscriptionId) return null;
  let rzp;
  try {
    rzp = getRzp();
  } catch {
    return null;
  }
  try {
    const rzSub = await rzp.subscriptions.fetch(subscriptionId);
    const nextBillingDate = extractNextBillingDateFromRazorpaySub(rzSub, user);
    const lastBillingDate = rzSub?.current_start
      ? new Date(Number(rzSub.current_start) * 1000)
      : (user?.lastBillingDate || null);
    const patch = {
      subscriptionStatus: rzSub.status || user?.subscriptionStatus || '',
      nextBillingDate,
      lastBillingDate: lastBillingDate && !Number.isNaN(lastBillingDate.getTime()) ? lastBillingDate : null,
    };
    await User.findByIdAndUpdate(user._id, patch);
    await Subscription.updateMany(
      { user: user._id, razorpaySubscriptionId: subscriptionId },
      { $set: patch },
    );
    return patch;
  } catch (err) {
    logger.warn(`syncRazorpaySubscriptionState failed ${subscriptionId}: ${err.message}`);
    return null;
  }
}

/** POST /api/payments/upgrade-quote */
export const getUpgradeQuote = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select('plan planExpiresAt autoRenew razorpaySubscriptionId individualPlanCode');
    if (!user) return next(new AppError('User not found', 404));
    const targetPlan = String(req.body?.targetPlan || '').trim().toLowerCase();
    const durationMonths = [1, 3, 6, 12].includes(Number(req.body?.durationMonths)) ? Number(req.body?.durationMonths) : 1;
    const plans = await Plan.find({ audience: 'individual', isActive: true })
      .select('code name pricing sortOrder')
      .sort({ sortOrder: 1, createdAt: -1 })
      .lean();
    const current = await resolveCurrentIndividualPlan(user, plans);
    const target = plans.find((p) => p.code === targetPlan);
    if (!target) return next(new AppError('Invalid target plan.', 400));
    if (current?.code && target.code === current.code) {
      return next(new AppError('You are already on this plan.', 400));
    }
    const eligible = filterUpgradeEligiblePlans(plans, current, user);
    if (!eligible.some((p) => p.code === target.code)) {
      return next(new AppError('Target plan is not available as an upgrade.', 400));
    }
    const currentOrder = current != null ? Number(current.sortOrder ?? 0) : -1;
    const targetOrder = Number(target.sortOrder ?? 0);
    const upgrade = targetOrder > currentOrder;
    const downgrade = targetOrder < currentOrder;
    const planCostPaise = Math.max(
      100,
      Number(
        durationMonths === 12
          ? (target.pricing?.yearlyPricePaise ?? target.pricing?.monthlyPricePaise * 12)
          : durationMonths === 6
            ? (target.pricing?.halfYearlyPricePaise ?? target.pricing?.monthlyPricePaise * 6)
            : durationMonths === 3
              ? (target.pricing?.quarterlyPricePaise ?? target.pricing?.monthlyPricePaise * 3)
              : target.pricing?.monthlyPricePaise,
      ) || 0,
    );

    if (downgrade) {
      return res.json({
        allowedImmediate: false,
        downgradeDeferred: true,
        message: 'Downgrade applies after current billing period ends.',
        currentPlan: current?.code || 'free',
        newPlan: targetPlan,
      });
    }

    const prorationBasis = upgrade
      ? await resolveCurrentPlanProrationBasis(user)
      : { amountPaidPaise: 0, totalCycleDays: 30, remainingDays: 0 };
    const proratedCreditPaise = upgrade
      ? computeProratedUpgradeCreditPaise({
        user,
        amountPaidPaise: prorationBasis.amountPaidPaise,
        totalCycleDays: prorationBasis.totalCycleDays,
      })
      : 0;
    const creditAppliedPaise = Math.min(proratedCreditPaise, Math.max(0, planCostPaise - 100));
    const payablePaise = Math.max(100, planCostPaise - creditAppliedPaise);

    res.json({
      allowedImmediate: true,
      currentPlan: current?.code || 'free',
      newPlan: targetPlan,
      durationMonths,
      currentPlanExpiresAt: user.planExpiresAt || null,
      currentPlanMonthlyPricePaise: current?.pricing?.monthlyPricePaise || 0,
      currentPlanAmountPaidPaise: prorationBasis.amountPaidPaise,
      remainingDays: prorationBasis.remainingDays,
      totalCycleDays: prorationBasis.totalCycleDays,
      planCostPaise,
      proratedCreditPaise,
      creditAppliedPaise,
      payablePaise,
      autoPayActive: Boolean(user.autoRenew && user.razorpaySubscriptionId),
    });
  } catch (err) {
    next(err);
  }
};

async function applyRecurringChargeSuccess({ subscriptionId, paymentId, orderId, invoiceId, amount, method, eventId, raw }) {
  const subscription = await Subscription.findOne({ razorpaySubscriptionId: subscriptionId }).sort({ createdAt: -1 });
  if (!subscription) return;
  const user = await User.findById(subscription.user);
  if (!user) return;

  // Idempotency guard
  const existing = await Transaction.findOne({
    provider: 'razorpay',
    razorpaySubscriptionId: subscriptionId,
    razorpayPaymentId: paymentId,
    status: 'paid',
  });
  if (existing) return;

  const now = new Date();
  const priorEnd = user.planExpiresAt && user.planExpiresAt > now ? user.planExpiresAt : now;
  const nextEnd = addMonthsClamped(priorEnd, 1);
  user.plan = 'pro';
  user.individualPlanCode = subscription.individualPlanCode || user.individualPlanCode || 'premium';
  user.planExpiresAt = nextEnd;
  user.examsCreatedThisMonth = 0;
  user.monthlyExamResetDate = now;
  user.autoRenew = true;
  user.autoRenewProvider = 'razorpay';
  user.razorpaySubscriptionId = subscriptionId;
  user.subscriptionStatus = 'active';
  user.lastBillingDate = now;
  user.nextBillingDate = nextEnd;
  user.gracePeriodEndsAt = null;
  user.subscriptionPaymentMethod = method || user.subscriptionPaymentMethod || '';
  await user.save({ validateBeforeSave: false });

  const tx = await Transaction.create({
    user: user._id,
    billingScope: 'personal',
    subscription: subscription._id,
    provider: 'razorpay',
    providerEventId: eventId || '',
    razorpayOrderId: orderId || `sub_${subscriptionId}_${Date.now()}`,
    razorpayPaymentId: paymentId || '',
    razorpaySubscriptionId: subscriptionId,
    razorpayInvoiceId: invoiceId || '',
    paymentMethod: method || '',
    amount: Number(amount) || subscription.amountPaid || 0,
    currency: 'INR',
    plan: 'pro',
    individualPlanCode: subscription.individualPlanCode || user.individualPlanCode || 'premium',
    purchaseType: 'subscription',
    durationMonths: 1,
    status: 'paid',
    receipt: `autopay_${Date.now()}`,
    metadata: raw || null,
  });

  subscription.status = 'active';
  subscription.autoRenewEnabled = true;
  subscription.subscriptionStatus = 'active';
  subscription.lastBillingDate = now;
  subscription.nextBillingDate = nextEnd;
  subscription.gracePeriodEndsAt = null;
  subscription.paymentMethod = method || subscription.paymentMethod || '';
  subscription.razorpayPaymentId = paymentId || subscription.razorpayPaymentId;
  subscription.razorpayOrderId = orderId || subscription.razorpayOrderId;
  subscription.endDate = nextEnd;
  await subscription.save();

  await createNotificationsForUsers([user._id], {
    type: 'general',
    title: 'Renewal successful',
    message: 'Your AutoPay renewal was successful. Premium access continues without interruption.',
    severity: 'success',
    meta: { transactionId: tx._id, subscriptionId },
  });
}

async function applyRecurringChargeFailure({ subscriptionId, reason, eventId, raw }) {
  const subscription = await Subscription.findOne({ razorpaySubscriptionId: subscriptionId }).sort({ createdAt: -1 });
  if (!subscription) return;
  const user = await User.findById(subscription.user);
  if (!user) return;

  const settings = await getSettings();
  const graceDays = Math.max(1, Number(settings.autopayGraceDays || 7));
  const now = new Date();
  const graceEnds = new Date(now.getTime() + graceDays * 24 * 60 * 60 * 1000);

  subscription.status = 'payment_pending';
  subscription.subscriptionStatus = 'payment_failed';
  subscription.gracePeriodEndsAt = graceEnds;
  subscription.latestInvoiceId = subscription.latestInvoiceId || '';
  await subscription.save();

  user.subscriptionStatus = 'payment_failed';
  user.gracePeriodEndsAt = graceEnds;
  await user.save({ validateBeforeSave: false });

  await Transaction.create({
    user: user._id,
    billingScope: 'personal',
    subscription: subscription._id,
    provider: 'razorpay',
    providerEventId: eventId || '',
    razorpayOrderId: `failed_${Date.now()}`,
    plan: 'pro',
    purchaseType: 'subscription',
    durationMonths: 1,
    amount: subscription.amountPaid || 0,
    status: 'failed',
    receipt: `autopay_failed_${Date.now()}`,
    metadata: raw || { reason },
  }).catch(() => {});

  await createNotificationsForUsers([user._id], {
    type: 'general',
    title: 'AutoPay payment failed',
    message: `We could not process your recurring payment. Grace period is active until ${graceEnds.toLocaleDateString('en-IN')}.`,
    severity: 'warning',
  });
}

/** POST /api/payments/webhook */
export const razorpayWebhook = async (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ message: 'Webhook secret is not configured' });

  const signature = req.headers['x-razorpay-signature'];
  const body = getWebhookBody(req);
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  if (signature !== expected) {
    return res.status(400).json({ message: 'Invalid webhook signature' });
  }

  const event = req.body?.event;
  const payload = req.body?.payload || {};
  const eventId = String(req.headers['x-razorpay-event-id'] || req.body?.payload?.payment?.entity?.id || `${req.body?.event || 'evt'}_${Date.now()}`);

  try {
    if (event === 'subscription.activated') {
      const subEntity = payload.subscription?.entity || {};
      const subscriptionId = subEntity.id;
      if (subscriptionId) {
        await Subscription.updateMany(
          { razorpaySubscriptionId: subscriptionId },
          {
            $set: {
              status: 'active',
              subscriptionStatus: 'active',
              autoRenewEnabled: true,
              mandateApprovedAt: new Date(),
              nextBillingDate: extractNextBillingDateFromRazorpaySub(subEntity, null),
            },
          },
        );
        const sub = await Subscription.findOne({ razorpaySubscriptionId: subscriptionId }).sort({ createdAt: -1 });
        if (sub) {
          const subUser = await User.findById(sub.user);
          const nextBillingDate = extractNextBillingDateFromRazorpaySub(subEntity, subUser);
          await User.findByIdAndUpdate(sub.user, {
            autoRenew: true,
            autoRenewProvider: 'razorpay',
            razorpaySubscriptionId: subscriptionId,
            subscriptionStatus: 'active',
            nextBillingDate,
          });
        }
      }
    } else if (event === 'subscription.charged') {
      const subEntity = payload.subscription?.entity || {};
      const paymentEntity = payload.payment?.entity || {};
      const invoiceEntity = payload.invoice?.entity || {};
      await applyRecurringChargeSuccess({
        subscriptionId: subEntity.id,
        paymentId: paymentEntity.id,
        orderId: paymentEntity.order_id,
        invoiceId: invoiceEntity.id,
        amount: paymentEntity.amount,
        method: paymentEntity.method || '',
        eventId,
        raw: req.body,
      });
    } else if (event === 'subscription.cancelled' || event === 'subscription.completed') {
      const subEntity = payload.subscription?.entity || {};
      const subscriptionId = subEntity.id;
      if (subscriptionId) {
        await Subscription.updateMany(
          { razorpaySubscriptionId: subscriptionId },
          {
            $set: {
              autoRenewEnabled: false,
              subscriptionStatus: event === 'subscription.completed' ? 'completed' : 'cancelled',
              status: 'cancelled',
              cancelledAt: new Date(),
            },
          },
        );
        const sub = await Subscription.findOne({ razorpaySubscriptionId: subscriptionId }).sort({ createdAt: -1 });
        if (sub) {
          await User.findByIdAndUpdate(sub.user, {
            autoRenew: false,
            subscriptionStatus: event === 'subscription.completed' ? 'completed' : 'cancelled',
          });
        }
      }
    } else if (event === 'payment.failed') {
      const paymentEntity = payload.payment?.entity || {};
      const subscriptionId = paymentEntity.subscription_id || payload.subscription?.entity?.id || '';
      if (subscriptionId) {
        await applyRecurringChargeFailure({
          subscriptionId,
          reason: paymentEntity?.error_description || 'Payment failed',
          eventId,
          raw: req.body,
        });
      }
    }

    return res.json({ received: true });
  } catch (err) {
    logger.error('razorpayWebhook processing failed:', err?.message || err);
    return res.status(500).json({ message: 'Webhook processing failed' });
  }
};

/** GET /api/payments/subscription */
export const getMySubscription = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    const now = new Date();
    if (
      user?.subscriptionStatus === 'payment_failed'
      && user?.gracePeriodEndsAt
      && user.gracePeriodEndsAt <= now
      && (!user.planExpiresAt || user.planExpiresAt <= now)
    ) {
      user.plan = 'free';
      user.planExpiresAt = null;
      user.autoRenew = false;
      user.subscriptionStatus = 'grace_expired';
      user.razorpaySubscriptionId = '';
      await user.save({ validateBeforeSave: false });
      await processPersonalSubscriptionLifecycle(user._id);
    }

    const snap = await computeExamUsageSnapshotWithEnterprise(user);
    const planUser = snap?.user || user;
    const catalog = await getBillingCatalogFromSettings();
    const settings = await getSettings();

    let enterprisePayload = null;
    let entLean = null;
    if (user.enterpriseId) {
      entLean = await Enterprise.findById(user.enterpriseId).lean();
      if (entLean) {
        const teacherCount = await User.countDocuments({ enterpriseId: user.enterpriseId, role: 'instructor' });
        const monthlyBasePaise = (entLean.estimatedMonthlyCostManualPaise != null && Number(entLean.estimatedMonthlyCostManualPaise) >= 100)
          ? Math.round(Number(entLean.estimatedMonthlyCostManualPaise))
          : Math.round(Number(entLean.estimatedMonthlyCost) || 0);
        const billingBreakdown = await getEnterpriseBillingBreakdown(entLean);
        const teacherExamUsage = user.role === 'principal'
          ? await buildPrincipalTeacherExamUsage(user.enterpriseId, entLean)
          : null;

        enterprisePayload = {
          id: entLean._id,
          name: entLean.name,
          mode: entLean.mode,
          teacherLimit: entLean.teacherLimit,
          teacherUsed: teacherCount,
          studentLimit: entLean.studentLimit ?? 2000,
          examsPerTeacherLimit: entLean.examsPerTeacherLimit,
          questionsPerExamLimit: entLean.questionsPerExamLimit,
          aiProctoringEnabled: entLean.aiProctoringEnabled !== false,
          aiListeningEnabled: entLean.aiListeningEnabled !== false,
          aiResourceProcessingEnabled: entLean.aiResourceProcessingEnabled !== false,
          codingExamsEnabled: entLean.codingExamsEnabled !== false,
          aiExamGenerationEnabled: entLean.aiExamGenerationEnabled !== false,
          estimatedMonthlyCostPaise: Math.round(Number(entLean.estimatedMonthlyCost) || 0),
          estimatedMonthlyCostManualPaise: entLean.estimatedMonthlyCostManualPaise ?? null,
          billingMonthlyBasePaise: monthlyBasePaise,
          billingBreakdown,
          orgPlanStartedAt: entLean.orgPlanStartedAt || null,
          orgPlanActive: !!entLean.orgPlanActive,
          orgPlanExpiresAt: entLean.orgPlanExpiresAt || null,
          orgPlanDurationMonths: entLean.orgPlanDurationMonths ?? null,
          orgTrialEndsAt: entLean.orgTrialEndsAt || null,
          subscriptionRenewalQueue: (entLean.subscriptionRenewalQueue || [])
            .filter((q) => q.status === 'pending')
            .map((q) => ({
              durationMonths: q.durationMonths,
              activatesAt: q.activatesAt,
              sequence: q.sequence,
            })),
          renewalTimeline: buildEnterpriseRenewalTimeline(entLean).segments,
          checkoutWillQueueEnterpriseTerm: !!(entLean.orgPlanExpiresAt && new Date(entLean.orgPlanExpiresAt) > new Date()),
          ...(teacherExamUsage ? { teacherExamUsage } : {}),
        };
      }
    }

    const managedByOrganization = !!(
      user.enterpriseId
      && user.role !== 'principal'
      && user.role !== 'admin'
    );

    const personalQueue = (planUser.subscriptionRenewalQueue || [])
      .filter((q) => q.status === 'pending')
      .map((q) => ({
        durationMonths: q.durationMonths,
        plan: q.plan,
        activatesAt: q.activatesAt,
        sequence: q.sequence,
      }))
      .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));

    const eff = snap?.effectivePlan ?? effectivePlanType(user);

    const subscription = await Subscription.findOne({
      user: req.user._id,
      status: { $in: ['active', 'pending', 'payment_pending', 'grace_period'] },
    }).sort({ createdAt: -1 });

    if (user?.autoRenew && user?.razorpaySubscriptionId) {
      const repaired = await syncRazorpaySubscriptionState(user, subscription);
      if (repaired) {
        user.nextBillingDate = repaired.nextBillingDate ?? user.nextBillingDate;
        user.lastBillingDate = repaired.lastBillingDate ?? user.lastBillingDate;
        user.subscriptionStatus = repaired.subscriptionStatus || user.subscriptionStatus;
      }
    }

    let entQuestionOverride = null;
    if (user.enterpriseId && (user.role === 'instructor' || user.role === 'principal') && entLean && enterpriseSubscriptionIsActive(entLean)) {
      entQuestionOverride = entLean.questionsPerExamLimit ?? null;
    }
    const maxQuestions = await getMaxQuestionsForUser(user, entQuestionOverride);

    const personalRenewalTimeline = buildPersonalRenewalTimeline(planUser).segments;

    const paidPersonalSubscriptionCount = await Transaction.countDocuments({
      user: user._id,
      status: 'paid',
      purchaseType: 'subscription',
      $or: [{ billingScope: 'personal' }, { billingScope: { $exists: false } }],
    });
    const planCatalog = await Plan.find({ audience: 'individual', isActive: true })
      .select('code name description pricing limits features featureSettings highlightedFeatures billing isRecommended isActive sortOrder')
      .sort({ sortOrder: 1, isRecommended: -1, createdAt: -1 })
      .lean();
    const billingCtx = await resolveBillingPlanContext(user, planCatalog);
    const currentIndividualPlan = billingCtx.currentPlan;
    const planLimitsCtx = billingCtx.limitsCtx;
    const upgradeEligiblePlans = billingCtx.upgradeEligiblePlans;

    res.json({
      plan: eff,
      planExpiresAt: planUser.planExpiresAt,
      instructorTrialEndsAt: planUser.instructorTrialEndsAt || null,
      instructorTrialUsed: !!planUser.instructorTrialUsed,
      examsCreatedThisMonth: snap?.usedThisMonth ?? 0,
      monthlyLimit: snap?.totalCap ?? 0,
      baseMonthlyIncluded: snap?.baseMonthlyCap ?? 0,
      bonusExamCredits: snap?.bonusSlots ?? 0,
      extraExamCreditsBalance: planUser.extraExamCreditsBalance || 0,
      remaining: snap?.remaining ?? 0,
      maxQuestions,
      canUseProctoring: planLimitsCtx?.features?.aiProctoring === true,
      planLimits: planLimitsCtx?.limits || null,
      planFeatures: planLimitsCtx?.features || null,
      featureList: planLimitsCtx?.featureList || [],
      planStatus: planLimitsCtx?.status || 'free',
      planDisplayName: billingCtx.currentPlanName || planLimitsCtx?.planName || 'Free',
      currentPlanCode: billingCtx.currentPlanCode || '',
      currentPlanSortOrder: billingCtx.currentSortOrder,
      upgradeEligiblePlans,
      managedByOrganization,
      enterprise: enterprisePayload,
      personalRenewalQueue: personalQueue,
      personalRenewalTimeline,
      paidPersonalSubscriptionCount,
      subscription,
      autoRenew: {
        enabled: Boolean(user.autoRenew),
        provider: user.autoRenewProvider || (subscription?.provider || ''),
        razorpaySubscriptionId: user.razorpaySubscriptionId || subscription?.razorpaySubscriptionId || '',
        subscriptionStatus: user.subscriptionStatus || subscription?.subscriptionStatus || '',
        nextBillingDate: user.nextBillingDate || subscription?.nextBillingDate || null,
        lastBillingDate: user.lastBillingDate || subscription?.lastBillingDate || null,
        paymentMethod: user.subscriptionPaymentMethod || subscription?.paymentMethod || '',
        gracePeriodEndsAt: user.gracePeriodEndsAt || subscription?.gracePeriodEndsAt || null,
      },
      currentIndividualPlan,
      availableIndividualPlans: planCatalog,
      pricingCatalog: {
        additionalExamCreditPricePaise: catalog.additionalExamCreditPricePaise,
        referPriceMonthlyPaise: catalog.referPriceMonthlyPaise,
        durations: catalog.durations,
        enterpriseRenewalDurations: catalog.enterpriseRenewalDurations,
        planExamLimits: catalog.planExamLimits,
        planMaxQuestions: catalog.planMaxQuestions,
        planPricePro: settings.planPricePro || 14900,
        planPriceEnterprise: settings.planPriceEnterprise || 199900,
      },
    });
  } catch (err) {
    next(err);
  }
};

/** GET /api/payments/billing-catalog — authenticated (needs plan context for add-ons). */
export const getBillingCatalog = async (req, res, next) => {
  try {
    const catalog = await getBillingCatalogFromSettings();
    res.json({ catalog });
  } catch (err) {
    next(err);
  }
};

function escapeInvoiceHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** GET /api/payments/transactions/:transactionId/invoice — HTML receipt download */
export const getTransactionInvoice = async (req, res, next) => {
  try {
    const txn = await Transaction.findById(req.params.transactionId);
    if (!txn || txn.user.toString() !== req.user._id.toString()) {
      return next(new AppError('Invoice not found.', 404));
    }
    if (txn.status !== 'paid') {
      return next(new AppError('Invoice is available after payment is completed.', 400));
    }
    const payer = await User.findById(req.user._id).select('name email').lean();
    const amountStr = `₹${(txn.amount / 100).toFixed(2)}`;
    const when = new Date(txn.updatedAt || txn.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
    const planLabel = txn.purchaseType === 'exam_credits'
      ? `Exam credits × ${txn.examCreditQuantity ?? '—'}`
      : txn.plan === 'enterprise'
        ? 'Organization subscription'
        : txn.plan === 'pro'
          ? 'Premium subscription'
          : String(txn.plan || 'Payment');
    const receipt = escapeInvoiceHtml(txn.receipt || txn._id.toString());
    const name = escapeInvoiceHtml(payer?.name || 'Customer');
    const email = escapeInvoiceHtml(payer?.email || '');
    const oid = escapeInvoiceHtml(txn.razorpayOrderId || '—');
    const pid = escapeInvoiceHtml(txn.razorpayPaymentId || '—');
    const whenEsc = escapeInvoiceHtml(when);
    const planEsc = escapeInvoiceHtml(planLabel);
    const amtEsc = escapeInvoiceHtml(amountStr);
    const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><title>Receipt — LikhitAI</title>
<style>
 body{font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem;color:#111}
 h1{font-size:1.25rem;margin:0 0 .5rem}
 .muted{color:#555;font-size:.875rem}
 table{width:100%;border-collapse:collapse;margin-top:1rem;font-size:.9rem}
 td{padding:.35rem 0;border-bottom:1px solid #e5e5e5}
 td:first-child{color:#555;width:42%}
 .amt{font-size:1.1rem;font-weight:600;padding-top:.75rem;border:none}
 footer{margin-top:2rem;font-size:.75rem;color:#777}
</style></head><body>
<h1>LikhitAI — Payment receipt</h1>
<p class="muted">Record of payment for your records. Contact support if you need a tax invoice with legal entity details.</p>
<p><strong>${name}</strong><br/><span class="muted">${email}</span></p>
<table>
<tr><td>Date</td><td>${whenEsc}</td></tr>
<tr><td>Description</td><td>${planEsc}</td></tr>
<tr><td>Razorpay order ID</td><td>${oid}</td></tr>
<tr><td>Razorpay payment ID</td><td>${pid}</td></tr>
<tr><td>Receipt reference</td><td>${receipt}</td></tr>
<tr><td colspan="2" class="amt">Amount paid — ${amtEsc}</td></tr>
</table>
<footer>Generated from your LikhitAI account.</footer>
</body></html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="likhitai-receipt-${txn.receipt || txn._id}.html"`);
    res.send(html);
  } catch (err) {
    next(err);
  }
};

export const getMyTransactions = async (req, res, next) => {
  try {
    const transactions = await Transaction.find({ user: req.user._id })
      .sort({ createdAt: -1 }).limit(50);
    res.json({ transactions });
  } catch (err) {
    next(err);
  }
};
