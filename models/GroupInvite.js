import crypto from 'crypto';
import mongoose from 'mongoose';

const groupInviteSchema = new mongoose.Schema({
  group:     { type: mongoose.Schema.Types.ObjectId, ref: 'Group', required: true },
  email:     { type: String, required: true, lowercase: true, trim: true },
  invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status:    { type: String, enum: ['pending', 'accepted', 'declined'], default: 'pending' },
  token:     {
    type: String,
    unique: true,
    default: () => crypto.randomBytes(28).toString('hex'),
  },
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
  },
}, { timestamps: true });

groupInviteSchema.index({ group: 1, email: 1 });
groupInviteSchema.index({ token: 1 });
groupInviteSchema.index({ email: 1, status: 1 });

export default mongoose.model('GroupInvite', groupInviteSchema);
