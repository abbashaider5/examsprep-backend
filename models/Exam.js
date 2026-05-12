import mongoose from 'mongoose';

const questionSchema = new mongoose.Schema({
  type: { type: String, enum: ['mcq', 'coding', 'descriptive'], default: 'mcq' },
  question: { type: String, required: true },
  // MCQ fields
  options: {
    type: [String],
    default: [],
    validate: {
      validator: function (v) { return this.type !== 'mcq' || v.length === 4; },
      message: 'MCQ questions must have exactly 4 options',
    },
  },
  correctAnswer: { type: Number, min: 0, max: 3 }, // not required for coding/descriptive
  // Coding fields
  language:       { type: String, default: 'javascript' },
  starterCode:    { type: String, default: '' },
  sampleSolution: { type: String, default: '' },
  // Descriptive fields
  modelAnswer:    { type: String, default: '' }, // instructor reference answer
  keyPoints:      [String],                      // key concepts that should appear
  // Common
  explanation: { type: String, default: '' },
  topic:       { type: String, default: '' },
});

const examSchema = new mongoose.Schema({
  title:      { type: String, required: true, trim: true },
  subject:    { type: String, required: true, trim: true },
  enterpriseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Enterprise', default: null, index: true },
  difficulty: { type: String, enum: ['easy', 'medium', 'hard'], default: 'medium' },
  examType:   { type: String, enum: ['mcq', 'descriptive', 'mixed', 'coding'], default: 'mcq' },
  topics:     [String],
  /** When set, regenerate flows can stay grounded in the same uploaded material */
  sourceResource: { type: mongoose.Schema.Types.ObjectId, ref: 'Resource', default: null, index: true },
  questions:  [questionSchema],
  createdBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  proctored:  { type: Boolean, default: false },
  timePerQuestion: { type: Number, default: 60 }, // user-set, seconds per question
  isPublic:   { type: Boolean, default: false },
  timesAttempted: { type: Number, default: 0 },

  // Instructor settings
  passingPercentage:   { type: Number, default: 75, min: 1, max: 100 },
  allowReattempt:      { type: Boolean, default: true },
  showFlashcards:      { type: Boolean, default: true },
  showReview:          { type: Boolean, default: true },
  certificateEnabled:  { type: Boolean, default: true },
  screenshotEnabled:   { type: Boolean, default: false },
  enableCoding:        { type: Boolean, default: false },
  allowCodeExecution:  { type: Boolean, default: false },
  // Result visibility controls
  showResultToUser:    { type: Boolean, default: true },
  showAnswersToUser:   { type: Boolean, default: true },
  // Expiry
  expiryDate:          { type: Date, default: null },

  /** When true, questionVariants holds 3 shuffled copies (same N questions each); counts as 3 toward creator usage */
  multipleSets: { type: Boolean, default: false },
  questionVariants: { type: mongoose.Schema.Types.Mixed, default: null },
}, { timestamps: true });

// Pre-save: only set timePerQuestion from difficulty if not explicitly provided
examSchema.pre('save', function (next) {
  if (!this.timePerQuestion || this.isNew) {
    const map = { easy: 45, medium: 60, hard: 90 };
    if (!this.timePerQuestion) this.timePerQuestion = map[this.difficulty] || 60;
  }
  next();
});

export default mongoose.model('Exam', examSchema);
