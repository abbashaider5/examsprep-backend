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
  /** Subject label — curriculum subject for admin resources; optional label for instructor uploads */
  subject:           { type: String, default: '', trim: true },
  /** CBSE / ICSE — required for scope admin resources */
  board:             { type: String, enum: ['CBSE', 'ICSE', ''], default: '' },
  /** Class 5–12 — required for scope admin resources */
  classLevel:        { type: String, default: '', trim: true },
  // 'admin' = global resource visible to all instructors
  // 'instructor' = per-group resource uploaded by an instructor
  scope:             { type: String, enum: ['admin', 'instructor'], required: true },
  group:             { type: mongoose.Schema.Types.ObjectId, ref: 'Group', default: null },

  /** uploading | processing | ready | failed — omit on legacy rows (treated as ready without chunks) */
  processingStatus:  { type: String, enum: ['uploading', 'processing', 'ready', 'failed'], default: undefined },
  processingErrorCode:   { type: String, default: '' },
  processingErrorMessage:{ type: String, default: '' },
  /** Short UX label while processing (e.g. OCR step); cleared when ready/failed */
  processingStageLabel:  { type: String, default: '' },
  /** Where processing stopped: extract | ocr | rasterize | prepare | convert | index | download | upload | other */
  processingFailedStage: { type: String, default: '' },
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

  /** PDF→DOCX recovery (Cloudinary raw); avoids repeat conversion & aids debugging */
  convertedDocxUrl:      { type: String, default: '' },
  convertedDocxPublicId:{ type: String, default: '' },
  conversionProvider:  { type: String, default: '' },
  /** none | pending | ready | failed */
  conversionStatus:    { type: String, enum: ['none', 'pending', 'ready', 'failed'], default: 'none' },
  conversionTimestamp: { type: Date, default: null },
  conversionErrorMessage:{ type: String, default: '' },
}, { timestamps: true });

resourceSchema.index({ scope: 1 });
resourceSchema.index({ scope: 1, board: 1, classLevel: 1, subject: 1 });
resourceSchema.index({ group: 1 });
resourceSchema.index({ uploadedBy: 1 });
resourceSchema.index({ processingStatus: 1 });

export default mongoose.model('Resource', resourceSchema);
