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
  purchaseType: { type: String, enum: ['subscription', 'exam_credits'], default: 'subscription' },
  durationMonths: { type: Number },
  examCreditQuantity: { type: Number },
  status: { type: String, enum: ['created', 'paid', 'failed'], default: 'created' },
  receipt: { type: String },
}, { timestamps: true });

transactionSchema.index({ user: 1, createdAt: -1 });
transactionSchema.index({ razorpayOrderId: 1 }, { unique: true });

export default mongoose.model('Transaction', transactionSchema);
