import mongoose from 'mongoose';

const userExamShuffleSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    exam: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', required: true },
    /** Which variant from exam.questionVariants (0..2) */
    variantIndex: { type: Number, default: 0, min: 0 },
    /** Display position → canonical index within variant */
    questionOrder: [{ type: Number }],
    /** Per display index: option permutation for MCQ, or null */
    optionPermutations: [{ type: mongoose.Schema.Types.Mixed }],
  },
  { timestamps: true }
);

userExamShuffleSchema.index({ user: 1, exam: 1 }, { unique: true });

export default mongoose.model('UserExamShuffle', userExamShuffleSchema);
