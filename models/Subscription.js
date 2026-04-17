import mongoose from 'mongoose';

const subscriptionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  plan: { type: String, enum: ['free', 'pro', 'enterprise'], required: true },
  status: { type: String, enum: ['active', 'expired', 'cancelled', 'pending'], default: 'pending' },
  razorpayOrderId: { type: String },
  razorpayPaymentId: { type: String },
  razorpaySignature: { type: String },
  amountPaid: { type: Number, required: true }, // in INR paise
  currency: { type: String, default: 'INR' },
  startDate: { type: Date },
  endDate: { type: Date },
  billingCycle: { type: String, enum: ['monthly'], default: 'monthly' },
}, { timestamps: true });

subscriptionSchema.index({ user: 1, status: 1 });

export default mongoose.model('Subscription', subscriptionSchema);
