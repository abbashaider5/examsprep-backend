import mongoose from 'mongoose';

const screenshotSchema = new mongoose.Schema({
  exam:       { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', required: true },
  user:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  result:     { type: mongoose.Schema.Types.ObjectId, ref: 'Result', default: null },
  imageData:  { type: String, default: null },   // base64 JPEG (fallback when Cloudinary not configured)
  imageUrl:   { type: String, default: null },   // Cloudinary URL (preferred)
  cloudinaryPublicId: { type: String, default: null }, // for retention cleanup (image resource_type)
  eventType:  { type: String, default: 'periodic_capture' },
  eventSource:{ type: String, default: 'client' },
  eventMessage: { type: String, default: '' },
  metadata:   { type: Map, of: String, default: {} },
  capturedAt: { type: Date, default: Date.now },
}, { timestamps: false });

/** Retention is enforced by `proctoringScreenshotRetention` (DB + Cloudinary); no TTL index (TTL cannot remove remote files). */

export default mongoose.model('Screenshot', screenshotSchema);
