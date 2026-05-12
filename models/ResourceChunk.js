import mongoose from 'mongoose';

/**
 * Vector-ready text chunks for RAG question generation.
 * Embeddings align with OpenAI text-embedding-3-small (1536 dims) by default.
 */
const resourceChunkSchema = new mongoose.Schema({
  resource:     { type: mongoose.Schema.Types.ObjectId, ref: 'Resource', required: true, index: true },
  enterpriseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Enterprise', default: null, index: true },
  uploadedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  chunkIndex:   { type: Number, required: true },
  text:         { type: String, required: true },
  /** OpenAI-style float vector; used for Atlas Vector Search and in-app cosine fallback */
  embedding:    { type: [Number], default: undefined },
  sectionTitle: { type: String, default: '' },
  charCount:    { type: Number, default: 0 },
  embeddingModel: { type: String, default: '' },
}, { timestamps: true });

resourceChunkSchema.index({ resource: 1, chunkIndex: 1 }, { unique: true });

export default mongoose.model('ResourceChunk', resourceChunkSchema);
