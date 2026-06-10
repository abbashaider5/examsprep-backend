import mongoose from 'mongoose';

const examAccessKeySchema = new mongoose.Schema({
  exam: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', required: true, unique: true },
  instructorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  accessKey: { type: String, required: true, unique: true, uppercase: true, trim: true },
  enrollmentLimit: { type: Number, required: true, min: 1 },
  enrolledCount: { type: Number, default: 0, min: 0 },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

examAccessKeySchema.index({ accessKey: 1 }, { unique: true });

export default mongoose.model('ExamAccessKey', examAccessKeySchema);
