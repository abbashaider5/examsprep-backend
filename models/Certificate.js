import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';

const certificateSchema = new mongoose.Schema({
  certId: { type: String, default: () => uuidv4(), unique: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  exam: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', required: true },
  result: { type: mongoose.Schema.Types.ObjectId, ref: 'Result', default: null },
  userName: String,
  examName: String,
  score: Number,
  percentage: Number,
  proctored: { type: Boolean, default: false },
  // Instructor info (when exam was shared via invite)
  instructorName: { type: String, default: null },
  instructorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  issuedAt: { type: Date, default: Date.now },
}, { timestamps: true });

export default mongoose.model('Certificate', certificateSchema);
