import crypto from 'crypto';
import Razorpay from 'razorpay';

import { AppError } from '../middleware/errorHandler.js';
import { getSettings } from '../models/SystemSettings.js';
import Subscription from '../models/Subscription.js';
import Transaction from '../models/Transaction.js';
import User from '../models/User.js';
import { sendPaymentSuccessEmail } from '../services/emailService.js';
import { fromReq, log } from '../utils/activityLogger.js';
import logger from '../utils/logger.js';

// Lazy Razorpay init
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
  pro:        { amount: 14900, label: '₹149/month', name: 'Pro' },
  enterprise: { amount: 34900, label: '₹349/month', name: 'Enterprise' },
};

/** Get plan prices — reads from SystemSettings, falls back to PLAN_PRICES */
const getEffectivePlanPrices = async () => {
  try {
    const settings = await getSettings();
    return {
      pro:        { amount: settings.planPricePro || 14900,        name: 'Pro',        label: `₹${Math.round((settings.planPricePro || 14900) / 100)}/month` },
      enterprise: { amount: settings.planPriceEnterprise || 34900, name: 'Enterprise', label: `₹${Math.round((settings.planPriceEnterprise || 34900) / 100)}/month` },
    };
  } catch {
    return PLAN_PRICES;
  }
};

/** POST /api/payments/create-order  { plan: 'pro' | 'enterprise' } */
export const createOrder = async (req, res, next) => {
  try {
    const { plan } = req.body;

    const effectivePrices = await getEffectivePlanPrices();
    if (!effectivePrices[plan]) return next(new AppError('Invalid plan', 400));

    let rzp;
    try {
      rzp = getRzp();
    } catch {
      return next(new AppError('Payment system is not configured. Please contact support.', 503));
    }

    const { amount } = effectivePrices[plan];
    // Razorpay receipt max 40 chars: "rcpt_" (5) + 8 chars user suffix + 13 digit ts = 26 chars
    const receipt = `rcpt_${req.user._id.toString().slice(-8)}_${Date.now().toString().slice(-8)}`;

    let order;
    try {
      order = await rzp.orders.create({ amount, currency: 'INR', receipt });
    } catch (rzpErr) {
      logger.error('Razorpay order creation failed:', rzpErr.message);
      return next(new AppError('Failed to create payment order. Please try again or contact support.', 502));
    }

    // Create pending transaction record (best-effort; don't fail if duplicate)
    try {
      await Transaction.create({
        user: req.user._id,
        razorpayOrderId: order.id,
        amount,
        plan,
        receipt,
        status: 'created',
      });
    } catch (txnErr) {
      // Duplicate key or other DB issue — order was already created in Razorpay, proceed
      logger.warn('Transaction record creation skipped:', txnErr.message);
    }

    res.json({ orderId: order.id, amount, currency: 'INR', keyId: process.env.RAZORPAY_KEY_ID });
  } catch (err) {
    next(err);
  }
};

/** POST /api/payments/verify  { razorpay_order_id, razorpay_payment_id, razorpay_signature, plan } */
export const verifyPayment = async (req, res, next) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, plan } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return next(new AppError('Missing required payment fields', 400));
    }
    if (!process.env.RAZORPAY_KEY_SECRET) {
      return next(new AppError('Payment system is not configured. Please contact support.', 503));
    }
    if (!PLAN_PRICES[plan]) return next(new AppError('Invalid plan', 400));

    // Get dynamic pricing
    const effectivePrices = await getEffectivePlanPrices();

    // Verify HMAC signature
    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expected !== razorpay_signature) {
      return next(new AppError('Payment verification failed. Please contact support if amount was deducted.', 400));
    }

    // Update transaction
    const txn = await Transaction.findOneAndUpdate(
      { razorpayOrderId: razorpay_order_id },
      { razorpayPaymentId: razorpay_payment_id, status: 'paid' },
      { new: true }
    );

    // Create / renew subscription
    const now = new Date();
    const endDate = new Date(now);
    endDate.setMonth(endDate.getMonth() + 1);

    let sub;
    try {
      sub = await Subscription.create({
        user: req.user._id,
        plan,
        status: 'active',
        razorpayOrderId: razorpay_order_id,
        razorpayPaymentId: razorpay_payment_id,
        razorpaySignature: razorpay_signature,
        amountPaid: txn?.amount || effectivePrices[plan].amount,
        startDate: now,
        endDate,
      });
    } catch (subErr) {
      // Subscription may already exist for this order — find it
      logger.warn('Subscription.create failed (may be duplicate):', subErr.message);
      sub = await Subscription.findOne({ razorpayOrderId: razorpay_order_id });
      if (!sub) return next(new AppError('Failed to activate subscription. Payment was captured — contact support.', 500));
    }

    if (txn) { txn.subscription = sub._id; await txn.save(); }

    // Upgrade user
    const user = await User.findById(req.user._id);
    user.plan = plan;
    user.planExpiresAt = endDate;
    // Reset monthly counter on plan upgrade
    user.examsCreatedThisMonth = 0;
    user.monthlyExamResetDate = now;
    await user.save({ validateBeforeSave: false });

    await log({
      user: req.user, action: 'plan_upgraded', category: 'profile',
      metadata: { plan, orderId: razorpay_order_id, paymentId: razorpay_payment_id },
      ...fromReq(req), severity: 'info',
    });

    // Send email async — reuse effectivePrices for name/label
    const settings = await getSettings();
    if (settings.emailPlanUpgradeEnabled) {
      sendPaymentSuccessEmail({
        email: user.email, name: user.name,
        plan: effectivePrices[plan].name,
        amount: effectivePrices[plan].label,
        expiresAt: endDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }),
      }).catch(logger.error);
    }

    res.json({
      success: true,
      plan: user.plan,
      planExpiresAt: user.planExpiresAt,
      remaining: user.getRemainingExams(),
    });
  } catch (err) {
    next(err);
  }
};

/** GET /api/payments/subscription  — current user's active subscription */
export const getMySubscription = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    const activeSub = await Subscription.findOne({ user: req.user._id, status: 'active' }).sort({ createdAt: -1 });

    res.json({
      plan: user.getEffectivePlan(),
      planExpiresAt: user.planExpiresAt,
      examsCreatedThisMonth: user.examsCreatedThisMonth || 0,
      monthlyLimit: user.getMonthlyLimit(),
      remaining: user.getRemainingExams(),
      maxQuestions: user.getMaxQuestions(),
      canUseProctoring: user.canUseProctoring(),
      subscription: activeSub,
    });
  } catch (err) {
    next(err);
  }
};

/** GET /api/payments/transactions  — current user's transaction history */
export const getMyTransactions = async (req, res, next) => {
  try {
    const transactions = await Transaction.find({ user: req.user._id })
      .sort({ createdAt: -1 }).limit(50);
    res.json({ transactions });
  } catch (err) {
    next(err);
  }
};
