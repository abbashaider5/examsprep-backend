import mongoose from 'mongoose';

const enterpriseSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 160 },
  contactEmail: { type: String, required: true, lowercase: true, trim: true },
  phone: { type: String, trim: true, maxlength: 32, default: '' },
  address: {
    country: { type: String, trim: true, maxlength: 100, default: '' },
    state: { type: String, trim: true, maxlength: 100, default: '' },
    city: { type: String, trim: true, maxlength: 100, default: '' },
    zipCode: { type: String, trim: true, maxlength: 20, default: '' },
  },
  /** school: class/student flows. institute: batch-based (existing). Immutable after create. */
  mode: { type: String, enum: ['school', 'institute'], required: true },
  /** CBSE or ICSE — required for school workflow; editable by admin. */
  board: { type: String, enum: ['CBSE', 'ICSE'], default: 'CBSE' },
  teacherLimit: { type: Number, default: 5, min: 1, max: 500 },
  /** Max students (school mode); used for org subscription display & caps. */
  studentLimit: { type: Number, default: 2000, min: 1, max: 500000 },
  examsPerTeacherLimit: { type: Number, default: 30, min: 1, max: 500 },
  questionsPerExamLimit: { type: Number, default: 100, min: 5, max: 500 },
  aiProctoringEnabled: { type: Boolean, default: true },
  /** Optional org-level AI feature gates (admin). Defaults preserve current product behavior. */
  aiListeningEnabled: { type: Boolean, default: true },
  aiResourceProcessingEnabled: { type: Boolean, default: true },
  codingExamsEnabled: { type: Boolean, default: true },
  aiExamGenerationEnabled: { type: Boolean, default: true },
  estimatedMonthlyCost: { type: Number, default: 0, min: 0 },
  /** When set, Razorpay enterprise checkout uses this monthly base (paise) instead of formula. */
  estimatedMonthlyCostManualPaise: { type: Number, default: null, min: 0 },
  principalUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  /** Organization-paid subscription window (admin or principal renewal). */
  orgPlanActive: { type: Boolean, default: false },
  orgPlanStartedAt: { type: Date, default: null },
  orgPlanExpiresAt: { type: Date, default: null },
  orgPlanDurationMonths: { type: Number, default: null },
  /** Optional org-wide trial (e.g. admin-granted). */
  orgTrialEndsAt: { type: Date, default: null },

  subscriptionRenewalQueue: [{
    durationMonths: { type: Number, required: true },
    plan: { type: String, default: 'enterprise' },
    activatesAt: { type: Date, required: true },
    sequence: { type: Number, default: 0 },
    razorpayOrderId: { type: String, default: '' },
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction' },
    status: { type: String, enum: ['pending', 'applied'], default: 'pending' },
    snapshot: { type: mongoose.Schema.Types.Mixed, default: null },
  }],
}, { timestamps: true });

enterpriseSchema.index({ contactEmail: 1 });
enterpriseSchema.index({ principalUser: 1 });

export default mongoose.model('Enterprise', enterpriseSchema);
