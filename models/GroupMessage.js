import mongoose from 'mongoose';

const groupMessageSchema = new mongoose.Schema({
  group:    { type: mongoose.Schema.Types.ObjectId, ref: 'Group', required: true },
  sender:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  text:     { type: String, trim: true, maxlength: 2000 },
  // 'text' | 'exam_share' | 'media' | 'system'
  type:     { type: String, enum: ['text', 'exam_share', 'media', 'system'], default: 'text' },
  // reply threading
  replyTo:  { type: mongoose.Schema.Types.ObjectId, ref: 'GroupMessage', default: null },
  // exam sharing
  examRef:  { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', default: null },
  // media
  mediaUrl:  { type: String, default: null },
  mediaType: { type: String, enum: ['image', 'document', 'video', null], default: null },
  fileName:  { type: String, default: null },
  fileSize:  { type: Number, default: null }, // bytes
  edited:    { type: Boolean, default: false },
}, { timestamps: true });

groupMessageSchema.index({ group: 1, createdAt: -1 });

export default mongoose.model('GroupMessage', groupMessageSchema);
