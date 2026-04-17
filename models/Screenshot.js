import mongoose from 'mongoose';

const screenshotSchema = new mongoose.Schema({
  exam:       { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', required: true },
  user:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  result:     { type: mongoose.Schema.Types.ObjectId, ref: 'Result', default: null },
  imageData:  { type: String, default: null },   // base64 JPEG (fallback when Cloudinary not configured)
  imageUrl:   { type: String, default: null },   // Cloudinary URL (preferred)
  capturedAt: { type: Date, default: Date.now },
}, { timestamps: false });

// TTL: auto-delete screenshots after 30 days
screenshotSchema.index({ capturedAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

export default mongoose.model('Screenshot', screenshotSchema);
