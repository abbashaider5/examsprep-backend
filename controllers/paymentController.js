import crypto from 'crypto';
import Razorpay from 'razorpay';

import { AppError } from '../middleware/errorHandler.js';
import Enterprise from '../models/Enterprise.js';
import { getSettings } from '../models/SystemSettings.js';
import Subscription from '../models/Subscription.js';
import Transaction from '../models/Transaction.js';
import User from '../models/User.js';
import { sendPaymentSuccessEmail } from '../services/emailService.js';
import {
  enterpriseTermTotalPaise,
  getBillingCatalogFromSettings,
  subscriptionPayableForMonths,
} from '../services/billingCatalogService.js';
import { getEnterpriseBillingBreakdown } from '../services/enterpriseBillingService.js';
import {
  computeExamUsageSnapshot,
  computeExamUsageSnapshotWithEnterprise,
  effectivePlanType,
  effectivePlanTypeWithEnterprise,
  getMaxQuestionsForUser,
  hasActivePaidPlanForCredits,
} from '../services/subscriptionUsageService.js';
import {
  addMonthsClamped,
  buildEnterpriseRenewalTimeline,
  buildEnterpriseSnapshot,
  buildPersonalRenewalTimeline,
  enqueueEnterpriseRenewal,
  enqueuePersonalRenewal,
  enterpriseSubscriptionIsActive,
} from '../services/subscriptionLifecycleService.js';
import { fromReq, log } from '../utils/activityLogger.js';
import logger from '../utils/logger.js';

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
        const plan = body.plan === 'pro' ? 'pro' : null;
        if (!plan) return next(new AppError('Invalid plan', 400));
        amount = payable;
        planField = plan;
        receiptSuffix = `sub_${plan}_${durationMonths}m`;
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
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );

  user.plan = plan;
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
    res.json({
      success: true,
      plan: updatedUser.plan,
      planExpiresAt: updatedUser.planExpiresAt,
      remaining: snap?.remaining ?? 0,
      extraExamCreditsBalance: updatedUser.extraExamCreditsBalance || 0,
      examsTotalCap: snap?.totalCap ?? 0,
    });
  } catch (err) {
    next(err);
  }
};

/** GET /api/payments/subscription */
export const getMySubscription = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    const snap = await computeExamUsageSnapshotWithEnterprise(user);
    const planUser = snap?.user || user;
    const catalog = await getBillingCatalogFromSettings();

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
    const effWithEnt = effectivePlanTypeWithEnterprise(user, entLean);

    const subscription = await Subscription.findOne({
      user: req.user._id,
      status: { $in: ['active', 'pending'] },
    }).sort({ createdAt: -1 });

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

    const retailProFeatures = {
      label: 'Premium (instructor)',
      monthlyExamLimit: catalog.planExamLimits?.pro ?? 20,
      maxQuestionsPerExam: catalog.planMaxQuestions?.pro ?? 50,
      proctoring: true,
      listeningAudio: true,
      resourceProcessing: true,
      codingExams: true,
      aiGeneration: true,
    };

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
      canUseProctoring: ['pro', 'enterprise'].includes(effWithEnt),
      managedByOrganization,
      enterprise: enterprisePayload,
      personalRenewalQueue: personalQueue,
      personalRenewalTimeline,
      paidPersonalSubscriptionCount,
      retailProFeatures,
      subscription,
      pricingCatalog: {
        additionalExamCreditPricePaise: catalog.additionalExamCreditPricePaise,
        referPriceMonthlyPaise: catalog.referPriceMonthlyPaise,
        durations: catalog.durations,
        enterpriseRenewalDurations: catalog.enterpriseRenewalDurations,
        planExamLimits: catalog.planExamLimits,
        planMaxQuestions: catalog.planMaxQuestions,
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
