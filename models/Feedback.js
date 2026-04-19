import mongoose from 'mongoose';

const feedbackSchema = new mongoose.Schema({
  user:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  rating:     { type: Number, min: 1, max: 5, required: true },   // overall / average
  ratings: {
    ui:          { type: Number, min: 1, max: 5 },
    performance: { type: Number, min: 1, max: 5 },
    features:    { type: Number, min: 1, max: 5 },
  },
  message:    { type: String, maxlength: 500, trim: true, default: '' },
  trigger:    { type: String, enum: ['exam_created', 'exam_completed', 'general'], default: 'general' },
  adminReply: { type: String, maxlength: 500, trim: true },
  repliedAt:  { type: Date },
}, { timestamps: true });

feedbackSchema.index({ user: 1, createdAt: -1 });

export default mongoose.model('Feedback', feedbackSchema);
