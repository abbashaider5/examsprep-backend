import mongoose from 'mongoose';

const activityLogSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  userEmail: String,
  userName: String,
  action: {
    type: String,
    required: true,
    enum: [
      'login', 'logout', 'signup', 'login_failed', 'account_locked',
      'token_refreshed', 'otp_requested', 'otp_verified', 'otp_failed',
      'exam_created', 'exam_started', 'exam_submitted', 'exam_deleted',
      'result_viewed', 'certificate_downloaded', 'certificate_verified',
      'profile_updated', 'password_changed',
      'admin_user_blocked', 'admin_user_unblocked', 'admin_user_deleted',
      'admin_role_changed', 'admin_settings_updated', 'admin_exam_deleted',
      'proctoring_violation', 'proctoring_terminated',
    ],
  },
  category: {
    type: String,
    enum: ['auth', 'exam', 'certificate', 'profile', 'admin', 'proctoring'],
    required: true,
  },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  ip: String,
  userAgent: String,
  severity: { type: String, enum: ['info', 'warning', 'critical'], default: 'info' },
}, { timestamps: true });

activityLogSchema.index({ createdAt: -1 });
activityLogSchema.index({ user: 1, createdAt: -1 });
activityLogSchema.index({ action: 1 });

export default mongoose.model('ActivityLog', activityLogSchema);
