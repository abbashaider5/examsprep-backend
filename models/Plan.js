import mongoose from 'mongoose';

const featureFlagsSchema = new mongoose.Schema({
  aiQuestionGeneration: { type: Boolean, default: true },
  aiRegeneration: { type: Boolean, default: true },
  aiFlashcards: { type: Boolean, default: true },
  aiExplanations: { type: Boolean, default: true },
  mcqExams: { type: Boolean, default: true },
  descriptiveExams: { type: Boolean, default: true },
  mixedExams: { type: Boolean, default: true },
  codingExams: { type: Boolean, default: true },
  listeningExams: { type: Boolean, default: true },
  certificates: { type: Boolean, default: true },
  answerReview: { type: Boolean, default: true },
  flashcards: { type: Boolean, default: true },
  reattempts: { type: Boolean, default: true },
  resultVisibility: { type: Boolean, default: true },
  aiProctoring: { type: Boolean, default: true },
  screenshotMonitoring: { type: Boolean, default: true },
  resourceUpload: { type: Boolean, default: true },
  aiResourceProcessing: { type: Boolean, default: true },
  adminResourcesAccess: { type: Boolean, default: true },
}, { _id: false });

const planSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 80 },
  description: { type: String, default: '', trim: true, maxlength: 400 },
  audience: { type: String, enum: ['individual'], default: 'individual', index: true },
  sortOrder: { type: Number, default: 100, index: true },
  pricing: {
    monthlyPricePaise: { type: Number, required: true, min: 100 },
    quarterlyPricePaise: { type: Number, default: null },
    halfYearlyPricePaise: { type: Number, default: null },
    yearlyPricePaise: { type: Number, default: null },
  },
  limits: {
    examsPerMonth: { type: Number, default: 20 },
    questionsPerExam: { type: Number, default: 50 },
    studentsAllowed: { type: Number, default: 0 },
    resourceUploadLimit: { type: Number, default: 20 },
    storageLimitGb: { type: Number, default: 5 },
  },
  features: { type: featureFlagsSchema, default: () => ({}) },
  /** Per-feature UI meta: { [featureKey]: { priority, highlighted, category } } */
  featureSettings: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  /** Legacy/simple override list of feature keys to highlight on pricing cards */
  highlightedFeatures: { type: [String], default: [] },
  billing: {
    autoPayAllowed: { type: Boolean, default: true },
    manualPaymentAllowed: { type: Boolean, default: true },
    trialDays: { type: Number, default: 0 },
    gracePeriodDays: { type: Number, default: 7 },
  },
  isRecommended: { type: Boolean, default: false, index: true },
  isActive: { type: Boolean, default: true, index: true },
}, { timestamps: true });

export default mongoose.model('Plan', planSchema);
