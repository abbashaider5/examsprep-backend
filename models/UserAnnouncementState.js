import mongoose from 'mongoose';

const stateSchema = new mongoose.Schema(
  {
    user:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    announcement: { type: mongoose.Schema.Types.ObjectId, ref: 'Announcement', required: true },
    isRead:      { type: Boolean, default: false },
    isDismissed: { type: Boolean, default: false },
    readAt:      { type: Date },
    dismissedAt: { type: Date },
  },
  { timestamps: true }
);

// Unique per user/announcement pair + fast lookup
stateSchema.index({ user: 1, announcement: 1 }, { unique: true });
stateSchema.index({ user: 1, isDismissed: 1 });

export default mongoose.model('UserAnnouncementState', stateSchema);
