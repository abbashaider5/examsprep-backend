import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema(
  {
    user:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type:    { type: String, enum: ['exam_shared', 'group_invite', 'group_joined', 'general'], default: 'general' },
    title:   { type: String, required: true, maxlength: 120 },
    message: { type: String, required: true, maxlength: 500 },
    link:    { type: String, default: null },  // client-side route, e.g. /groups
    isRead:  { type: Boolean, default: false, index: true },
    meta:    { type: mongoose.Schema.Types.Mixed, default: null }, // extra data (groupId, examId, etc.)
  },
  { timestamps: true }
);

// Index for efficient per-user unread queries
notificationSchema.index({ user: 1, isRead: 1, createdAt: -1 });

export default mongoose.model('Notification', notificationSchema);
