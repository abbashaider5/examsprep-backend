import mongoose from 'mongoose';

const NOTIFICATION_TYPES = [
  'exam_shared',
  'exam_terminated',
  'exam_result',
  'exam_invite',
  'exam_invite_accepted',
  'group_invite',
  'group_joined',
  'proctoring_violation',
  'batch_joined',
  'general',
];

const notificationSchema = new mongoose.Schema(
  {
    user:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type:    { type: String, enum: NOTIFICATION_TYPES, default: 'general' },
    title:   { type: String, required: true, maxlength: 200 },
    message: { type: String, required: true, maxlength: 1000 },
    link:    { type: String, default: null },
    isRead:  { type: Boolean, default: false, index: true },
    // Structured detail fields for the notification detail page
    details: { type: String, default: null },       // extended description / body text
    severity:{ type: String, enum: ['info', 'warning', 'critical', 'success'], default: 'info' },
    meta:    { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

notificationSchema.index({ user: 1, isRead: 1, createdAt: -1 });

export default mongoose.model('Notification', notificationSchema);
