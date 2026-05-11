import mongoose from 'mongoose';

/** One row per student enrolled in a school class (supports multi-class per student). */
const schoolClassEnrollmentSchema = new mongoose.Schema({
  schoolClass: { type: mongoose.Schema.Types.ObjectId, ref: 'SchoolClass', required: true, index: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  enterprise: { type: mongoose.Schema.Types.ObjectId, ref: 'Enterprise', required: true, index: true },
}, { timestamps: true });

schoolClassEnrollmentSchema.index({ schoolClass: 1, user: 1 }, { unique: true });
schoolClassEnrollmentSchema.index({ user: 1, enterprise: 1 });

export default mongoose.model('SchoolClassEnrollment', schoolClassEnrollmentSchema);
