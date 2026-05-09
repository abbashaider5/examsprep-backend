import mongoose from 'mongoose';

const groupChatModerationSchema = new mongoose.Schema({
  group: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', required: true, index: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  warningCount: { type: Number, default: 0, min: 0, max: 3 },
  isBlocked: { type: Boolean, default: false },
  blockedAt: { type: Date, default: null },
  blockedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  lastViolationAt: { type: Date, default: null },
  lastViolationMessage: { type: String, default: '' },
}, { timestamps: true });

groupChatModerationSchema.index({ group: 1, user: 1 }, { unique: true });
groupChatModerationSchema.index({ group: 1, isBlocked: 1, warningCount: -1 });

export default mongoose.model('GroupChatModeration', groupChatModerationSchema);
