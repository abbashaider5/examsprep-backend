import mongoose from 'mongoose';

const chatModerationLogSchema = new mongoose.Schema({
  group: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', required: true, index: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  originalMessage: { type: String, required: true, maxlength: 2000 },
  normalizedMessage: { type: String, required: true, maxlength: 4000 },
  detectedContent: [{ type: String }],
  warningCount: { type: Number, default: 0, min: 0, max: 3 },
  action: { type: String, enum: ['warned', 'blocked', 'blocked_message_attempt', 'unlocked_by_instructor'], required: true },
  triggeredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

chatModerationLogSchema.index({ group: 1, createdAt: -1 });
chatModerationLogSchema.index({ user: 1, createdAt: -1 });

export default mongoose.model('ChatModerationLog', chatModerationLogSchema);
