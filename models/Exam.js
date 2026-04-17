import mongoose from 'mongoose';

const questionSchema = new mongoose.Schema({
  type: { type: String, enum: ['mcq', 'coding'], default: 'mcq' },
  question: { type: String, required: true },
  // MCQ fields
  options: {
    type: [String],
    default: [],
    validate: {
      validator: function (v) { return this.type === 'coding' || v.length === 4; },
      message: 'MCQ questions must have exactly 4 options',
    },
  },
  correctAnswer: { type: Number, min: 0, max: 3 }, // not required for coding
  // Coding fields
  language:       { type: String, default: 'javascript' },
  starterCode:    { type: String, default: '' },
  sampleSolution: { type: String, default: '' },
  // Common
  explanation: { type: String, default: '' },
  topic:       { type: String, default: '' },
});

const examSchema = new mongoose.Schema({
  title:      { type: String, required: true, trim: true },
  subject:    { type: String, required: true, trim: true },
  difficulty: { type: String, enum: ['easy', 'medium', 'hard'], required: true },
  topics:     [String],
  questions:  [questionSchema],
  createdBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  proctored:  { type: Boolean, default: false },
  timePerQuestion: { type: Number },
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
}, { timestamps: true });

examSchema.pre('save', function (next) {
  const map = { easy: 45, medium: 75, hard: 120 };
  this.timePerQuestion = map[this.difficulty];
  next();
});

export default mongoose.model('Exam', examSchema);
