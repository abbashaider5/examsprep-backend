import crypto from 'crypto';
import mongoose from 'mongoose';

const enterpriseTeacherInviteSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true, index: true },
  enterprise: { type: mongoose.Schema.Types.ObjectId, ref: 'Enterprise', required: true, index: true },
  email: { type: String, required: true, lowercase: true, trim: true },
  name: { type: String, required: true, trim: true, maxlength: 60 },
  invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status: { type: String, enum: ['pending', 'accepted', 'cancelled'], default: 'pending' },
}, { timestamps: true });

enterpriseTeacherInviteSchema.pre('validate', function (next) {
  if (!this.token) {
    this.token = crypto.randomBytes(32).toString('hex');
  }
  next();
});

export default mongoose.model('EnterpriseTeacherInvite', enterpriseTeacherInviteSchema);
