import mongoose from 'mongoose';

const schoolClassSchema = new mongoose.Schema({
  enterprise: { type: mongoose.Schema.Types.ObjectId, ref: 'Enterprise', required: true, index: true },
  teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  section: { type: String, trim: true, maxlength: 40, default: '' },
  academicYear: { type: String, trim: true, maxlength: 20, default: '' },
}, { timestamps: true });

schoolClassSchema.index({ enterprise: 1, name: 1 });

export default mongoose.model('SchoolClass', schoolClassSchema);
