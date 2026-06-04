import mongoose from 'mongoose';

const subscriptionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  plan: { type: String, enum: ['free', 'pro', 'enterprise'], required: true },
  individualPlanCode: { type: String, default: '', index: true },
  status: {
    type: String,
    enum: ['active', 'expired', 'cancelled', 'pending', 'payment_pending', 'grace_period'],
    default: 'pending',
  },
  provider: { type: String, enum: ['razorpay', 'stripe', 'paddle', 'manual'], default: 'manual' },
  razorpayOrderId: { type: String },
  razorpayPaymentId: { type: String },
  razorpaySignature: { type: String },
  razorpaySubscriptionId: { type: String, index: true },
  razorpayPlanId: { type: String, default: '' },
  autoRenewEnabled: { type: Boolean, default: false },
  subscriptionStatus: { type: String, default: '' },
  nextBillingDate: { type: Date, default: null },
  lastBillingDate: { type: Date, default: null },
  paymentMethod: { type: String, default: '' },
  gracePeriodEndsAt: { type: Date, default: null },
  mandateApprovedAt: { type: Date, default: null },
  cancelledAt: { type: Date, default: null },
  latestInvoiceId: { type: String, default: '' },
  latestInvoiceUrl: { type: String, default: '' },
  amountPaid: { type: Number, required: true }, // in INR paise
  currency: { type: String, default: 'INR' },
  startDate: { type: Date },
  endDate: { type: Date },
  billingCycle: { type: String, enum: ['monthly', 'multi'], default: 'monthly' },
  durationMonths: { type: Number, default: 1 },
  isTrial: { type: Boolean, default: false, index: true },
}, { timestamps: true });

subscriptionSchema.index({ user: 1, status: 1 });

export default mongoose.model('Subscription', subscriptionSchema);
