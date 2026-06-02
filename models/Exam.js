import mongoose from 'mongoose';

const questionSchema = new mongoose.Schema({
  type: { type: String, enum: ['mcq', 'coding', 'descriptive'], default: 'mcq' },
  question: { type: String, required: true },
  // MCQ fields
  options: {
    type: [String],
    default: [],
    validate: {
      validator: function (v) { return this.type !== 'mcq' || (Array.isArray(v) && v.length === 4); },
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
  // AI listening / narration (optional; backward compatible)
  isAudioQuestion: { type: Boolean, default: false },
  /** e.g. dictation, listening_comprehension, audio_mcq — extensible */
  listeningExerciseType: { type: String, default: '' },
  /** Legacy / optional direct URL; authenticated exams use audioCloudinaryPublicId */
  audioUrl: { type: String, default: '' },
  audioCloudinaryPublicId: { type: String, default: '' },
  /** Text shown to students after submit / accessibility (may be empty for dictation) */
  audioTranscript: { type: String, default: '' },
  /** Spoken script — hidden from students during delivery */
  narrationText: { type: String, default: '' },
  /** Max play sessions via secure token endpoint; omit = unlimited */
  replayLimit: { type: Number, default: undefined },
  audioDuration: { type: Number, default: undefined },
  audioVoice: { type: String, default: '' },
  audioLanguage: { type: String, default: '' },
});

const examSchema = new mongoose.Schema({
  title:      { type: String, required: true, trim: true },
  subject:    { type: String, required: true, trim: true },
  board:      { type: String, enum: ['CBSE', 'ICSE', ''], default: '' },
  /** School exams: class 5–12 from admin resource mappings */
  classLevel: { type: String, default: '', trim: true },
  /** Optional custom guidance appended to all AI generation for this exam */
  additionalAiInstructions: { type: String, default: '', trim: true, maxlength: 4000 },
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

  /** Listening / AI audio questions (CAMB.AI + stored audio) */
  includeListeningQuestions: { type: Boolean, default: false },
  listeningQuestionCount: { type: Number, default: 0, min: 0, max: 50 },
  listeningVoiceAccent: { type: String, default: '' },
  listeningNarrationStyle: { type: String, default: '' },
  listeningResourceGrounded: { type: Boolean, default: undefined },
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
