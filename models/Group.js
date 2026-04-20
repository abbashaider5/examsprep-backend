import mongoose from 'mongoose';

const groupSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true, maxlength: 80 },
  description: { type: String, trim: true, maxlength: 300, default: '' },
  instructor:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  members:     [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  sharedExams: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Exam' }],
  isActive:    { type: Boolean, default: true },
  settings: {
    allowMedia:  { type: Boolean, default: true },
    whoCanSend:  { type: String, enum: ['all', 'instructorOnly'], default: 'all' },
    isPrivate:   { type: Boolean, default: false },
  },
}, { timestamps: true });

groupSchema.index({ instructor: 1 });
groupSchema.index({ members: 1 });

export default mongoose.model('Group', groupSchema);
