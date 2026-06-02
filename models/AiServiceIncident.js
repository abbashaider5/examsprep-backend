import mongoose from 'mongoose';

const aiServiceIncidentSchema = new mongoose.Schema(
  {
    status: { type: String, enum: ['active', 'resolved'], default: 'active', index: true },
    /** Single global outage key — one alert per 24h window */
    alertKey: { type: String, default: 'global-ai-outage', index: true },
    provider: { type: String, default: '' },
    providerDisplayName: { type: String, default: '' },
    errorType: { type: String, default: '' },
    errorCode: { type: String, default: '' },
    model: { type: String, default: '' },
    tokensUsed: { type: Number, default: null },
    tokensLimit: { type: Number, default: null },
    environment: { type: String, default: '' },
    firstDetectedAt: { type: Date, default: Date.now, index: true },
    lastDetectedAt: { type: Date, default: Date.now },
    resolvedAt: { type: Date, default: null },
    affectedUserIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    affectedUserCount: { type: Number, default: 0 },
    failureCount: { type: Number, default: 0 },
    lastErrorSample: { type: mongoose.Schema.Types.Mixed, default: null },
    requestIds: [{ type: String }],
    alertSentAt: { type: Date, default: null },
    restoredNotificationSentAt: { type: Date, default: null },
  },
  { timestamps: true },
);

aiServiceIncidentSchema.index({ status: 1, firstDetectedAt: -1 });

export default mongoose.model('AiServiceIncident', aiServiceIncidentSchema);
