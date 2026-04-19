import mongoose from 'mongoose';

const announcementSchema = new mongoose.Schema(
  {
    title:   { type: String, required: true, trim: true, maxlength: 120 },
    message: { type: String, required: true, trim: true, maxlength: 1000 },
    type: {
      type: String,
      enum: ['info', 'warning', 'success', 'error'],
      default: 'info',
    },
    targetAudience: {
      type: String,
      enum: ['all', 'free', 'pro', 'enterprise'],
      default: 'all',
    },
    isActive:  { type: Boolean, default: true },
    expiresAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Compound index for efficient audience + expiry queries
announcementSchema.index({ isActive: 1, expiresAt: 1, targetAudience: 1 });

export default mongoose.model('Announcement', announcementSchema);
