import mongoose from 'mongoose';

const contactSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    type: { type: String, enum: ['Individual', 'Instructor', 'Institute', 'Other'], required: true },
    message: { type: String, required: true },
    status: { type: String, enum: ['pending', 'in_progress', 'resolved'], default: 'pending' },
    adminReply: { type: String, default: null },
    repliedAt: { type: Date, default: null },
    repliedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    ipAddress: { type: String },
  },
  { timestamps: true }
);

export default mongoose.model('Contact', contactSchema);
