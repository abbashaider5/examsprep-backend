import mongoose from 'mongoose';

const answerSchema = new mongoose.Schema({
  questionIndex:  Number,
  selectedOption: { type: Number, default: null }, // MCQ
  code:           { type: String, default: '' },   // Coding questions
  aiScore:        { type: Number, default: null },  // 0–100 from AI eval
  aiFeedback:     { type: String, default: '' },
  isCorrect:      Boolean,
  timeTaken:      Number,
  flagged:        { type: Boolean, default: false },
});

const resultSchema = new mongoose.Schema({
  user:             { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  exam:             { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', required: true },
  answers:          [answerSchema],
  score:            { type: Number, required: true },
  totalQuestions:   { type: Number, required: true },
  correctCount:     { type: Number, required: true },
  incorrectCount:   { type: Number, required: true },
  unattemptedCount: { type: Number, required: true },
  percentage:       { type: Number, required: true },
  timeTaken:        { type: Number },
  passed:           { type: Boolean, required: true },
  proctored:        { type: Boolean, default: false },
  violations:       { type: Number, default: 0 },
  topicAccuracy:    { type: Map, of: Number },
  xpEarned:         { type: Number, default: 0 },
  certificateId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Certificate' },
  hasCodingQuestions: { type: Boolean, default: false },
}, { timestamps: true });

export default mongoose.model('Result', resultSchema);
