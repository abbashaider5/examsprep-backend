import mongoose from 'mongoose';

const resourceSchema = new mongoose.Schema({
  title:             { type: String, required: true, trim: true },
  originalName:      { type: String, default: '' },
  mimetype:          { type: String, default: '' },
  size:              { type: Number, default: 0 },
  pages:             { type: Number, default: 0 },
  cloudinaryUrl:     { type: String, default: '' },    // URL to the file on Cloudinary
  cloudinaryPublicId:{ type: String, default: '' },    // for deletion
  uploadedBy:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  enterpriseId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Enterprise', default: null, index: true },
  /** Optional subject label for retrieval / exams (teacher-provided) */
  subject:           { type: String, default: '', trim: true },
  // 'admin' = global resource visible to all instructors
  // 'instructor' = per-group resource uploaded by an instructor
  scope:             { type: String, enum: ['admin', 'instructor'], required: true },
  group:             { type: mongoose.Schema.Types.ObjectId, ref: 'Group', default: null },

  /** uploading | processing | ready | failed — omit on legacy rows (treated as ready without chunks) */
  processingStatus:  { type: String, enum: ['uploading', 'processing', 'ready', 'failed'], default: undefined },
  processingErrorCode:   { type: String, default: '' },
  processingErrorMessage:{ type: String, default: '' },
  chunkCount:        { type: Number, default: 0 },
  extractedCharCount:{ type: Number, default: 0 },
  /** Lightweight outline for chapter/topic UX (headings detected heuristically) */
  structureOutline:  [{
    title: { type: String, required: true },
    level: { type: Number, default: 1 },
    approxCharOffset: { type: Number, default: 0 },
  }],
  embeddingModel:    { type: String, default: '' },
  processedAt:       { type: Date, default: null },
}, { timestamps: true });

resourceSchema.index({ scope: 1 });
resourceSchema.index({ group: 1 });
resourceSchema.index({ uploadedBy: 1 });
resourceSchema.index({ processingStatus: 1 });

export default mongoose.model('Resource', resourceSchema);
