import crypto from 'crypto';
import mongoose from 'mongoose';

const examInviteSchema = new mongoose.Schema({
  exam: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', required: true },
  invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  email: { type: String, required: true, lowercase: true, trim: true },
  token: { type: String, unique: true, default: () => crypto.randomBytes(32).toString('hex') },
  status: { type: String, enum: ['pending', 'accepted', 'expired'], default: 'pending' },
  result: { type: mongoose.Schema.Types.ObjectId, ref: 'Result', default: null },
  reattemptCount: { type: Number, default: 0 },
  expiresAt: { type: Date, default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
}, { timestamps: true });

examInviteSchema.index({ token: 1 }, { unique: true });
examInviteSchema.index({ exam: 1, email: 1 });

export default mongoose.model('ExamInvite', examInviteSchema);
