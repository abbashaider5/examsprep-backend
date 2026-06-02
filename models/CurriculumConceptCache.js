import mongoose from 'mongoose';

const curriculumConceptCacheSchema = new mongoose.Schema(
  {
    board: { type: String, required: true, trim: true, index: true },
    classLevel: { type: String, required: true, trim: true, index: true },
    subject: { type: String, required: true, trim: true, index: true },
    /** Hash of linked admin resource ids + versions — bust cache when resources change */
    sourceFingerprint: { type: String, required: true, index: true },
    conceptTopics: [{ type: String }],
    teachingGuidance: { type: String, default: '' },
    sectionTitles: [{ type: String }],
    expansionSource: { type: String, enum: ['ai', 'local', 'hybrid'], default: 'ai' },
    expandedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

curriculumConceptCacheSchema.index(
  { board: 1, classLevel: 1, subject: 1, sourceFingerprint: 1 },
  { unique: true },
);

export default mongoose.model('CurriculumConceptCache', curriculumConceptCacheSchema);
