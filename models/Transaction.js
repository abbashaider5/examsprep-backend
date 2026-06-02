import mongoose from 'mongoose';

const transactionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  billingScope: { type: String, enum: ['personal', 'enterprise'], default: 'personal' },
  enterprise: { type: mongoose.Schema.Types.ObjectId, ref: 'Enterprise', default: null },
  subscription: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscription' },
  razorpayOrderId: { type: String, required: true },
  razorpayPaymentId: { type: String },
  amount: { type: Number, required: true },   // in INR paise
  currency: { type: String, default: 'INR' },
  plan: { type: String, enum: ['pro', 'enterprise', 'exam_credits'], required: true },
  individualPlanCode: { type: String, default: '', index: true },
  purchaseType: { type: String, enum: ['subscription', 'exam_credits'], default: 'subscription' },
  durationMonths: { type: Number },
  examCreditQuantity: { type: Number },
  status: { type: String, enum: ['created', 'paid', 'failed'], default: 'created' },
  receipt: { type: String },
  provider: { type: String, enum: ['razorpay', 'stripe', 'paddle', 'manual'], default: 'razorpay' },
  providerEventId: { type: String, default: '' },
  razorpaySubscriptionId: { type: String, default: '', index: true },
  razorpayInvoiceId: { type: String, default: '' },
  paymentMethod: { type: String, default: '' },
  metadata: { type: mongoose.Schema.Types.Mixed, default: null },
}, { timestamps: true });

transactionSchema.index({ user: 1, createdAt: -1 });
transactionSchema.index({ razorpayOrderId: 1 }, { unique: true });
transactionSchema.index({ providerEventId: 1 }, { unique: true, sparse: true });

export default mongoose.model('Transaction', transactionSchema);
