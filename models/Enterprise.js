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
  teacherLimit: { type: Number, default: 5, min: 1, max: 500 },
  examsPerTeacherLimit: { type: Number, default: 30, min: 1, max: 500 },
  questionsPerExamLimit: { type: Number, default: 100, min: 5, max: 500 },
  aiProctoringEnabled: { type: Boolean, default: true },
  estimatedMonthlyCost: { type: Number, default: 0, min: 0 },
  principalUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

enterpriseSchema.index({ contactEmail: 1 });
enterpriseSchema.index({ principalUser: 1 });

export default mongoose.model('Enterprise', enterpriseSchema);
