import mongoose from 'mongoose';

const answerSchema = new mongoose.Schema({
  questionIndex:  Number,
  selectedOption: { type: Number, default: null }, // MCQ
  code:           { type: String, default: '' },   // Coding questions
  textAnswer:     { type: String, default: '' },   // Descriptive questions
  aiScore:        { type: Number, default: null },  // 0–100 from AI eval
  aiFeedback:     { type: String, default: '' },
  isCorrect:      Boolean,
  timeTaken:      Number,
  flagged:        { type: Boolean, default: false },
});

const proctoringEventSchema = new mongoose.Schema({
  type: { type: String, default: 'violation' },
  severity: { type: String, enum: ['info', 'warning', 'critical'], default: 'warning' },
  message: { type: String, required: true },
  source: { type: String, default: 'client' },
  timestamp: { type: Date, default: Date.now },
}, { _id: false });

const resultSchema = new mongoose.Schema({
  user:                   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  exam:                   { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', required: true },
  answers:                [answerSchema],
  score:                  { type: Number, required: true },
  totalQuestions:         { type: Number, required: true },
  correctCount:           { type: Number, required: true },
  incorrectCount:         { type: Number, required: true },
  unattemptedCount:       { type: Number, required: true },
  percentage:             { type: Number, required: true },
  timeTaken:              { type: Number },
  passed:                 { type: Boolean, required: true },
  proctored:              { type: Boolean, default: false },
  violations:             { type: Number, default: 0 },
  proctoringEvents:       { type: [proctoringEventSchema], default: [] },
  terminatedByProctoring: { type: Boolean, default: false },
  topicAccuracy:          { type: Map, of: Number },
  xpEarned:               { type: Number, default: 0 },
  certificateId:          { type: mongoose.Schema.Types.ObjectId, ref: 'Certificate' },
  hasCodingQuestions:     { type: Boolean, default: false },
}, { timestamps: true });

resultSchema.index({ user: 1, createdAt: -1 });
resultSchema.index({ exam: 1, createdAt: -1 });

export default mongoose.model('Result', resultSchema);
