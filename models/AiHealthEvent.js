import mongoose from 'mongoose';

const aiHealthEventSchema = new mongoose.Schema(
  {
    incident: { type: mongoose.Schema.Types.ObjectId, ref: 'AiServiceIncident', index: true },
    provider: { type: String, required: true },
    errorType: { type: String, default: '' },
    errorCode: { type: String, default: '' },
    model: { type: String, default: '' },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    requestId: { type: String, default: '' },
    operation: { type: String, default: '' },
    environment: { type: String, default: '' },
    message: { type: String, default: '' },
    rawResponse: { type: String, default: '' },
    stackTrace: { type: String, default: '' },
    tokensUsed: { type: Number, default: null },
    tokensLimit: { type: Number, default: null },
  },
  { timestamps: true },
);

aiHealthEventSchema.index({ createdAt: -1 });

export default mongoose.model('AiHealthEvent', aiHealthEventSchema);
