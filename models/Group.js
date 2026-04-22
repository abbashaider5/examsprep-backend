import mongoose from 'mongoose';

const sharedExamSchema = new mongoose.Schema({
  exam:     { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', required: true },
  sharedAt: { type: Date, default: Date.now },
}, { _id: false });

const groupSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true, maxlength: 80 },
  description: { type: String, trim: true, maxlength: 300, default: '' },
  instructor:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  members:     [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  sharedExams: [sharedExamSchema],
  isActive:    { type: Boolean, default: true },
  settings: {
    allowMedia:        { type: Boolean, default: true },
    whoCanSend:        { type: String, enum: ['all', 'instructorOnly'], default: 'all' },
    isPrivate:         { type: Boolean, default: false },
    allowReactions:    { type: Boolean, default: true },
    allowReplies:      { type: Boolean, default: true },
    maxMembers:        { type: Number, default: 100 },
    muteNotifications: { type: Boolean, default: false },
  },
}, { timestamps: true });

groupSchema.index({ instructor: 1 });
groupSchema.index({ members: 1 });

export default mongoose.model('Group', groupSchema);
