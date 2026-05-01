import mongoose from 'mongoose';

const resourceSchema = new mongoose.Schema({
  title:             { type: String, required: true, trim: true },
  originalName:      { type: String, default: '' },
  mimetype:          { type: String, default: '' },
  size:              { type: Number, default: 0 },
  pages:             { type: Number, default: 0 },
  cloudinaryUrl:     { type: String, default: '' },    // URL to the file on Cloudinary
  cloudinaryPublicId:{ type: String, default: '' },    // for deletion
  uploadedBy:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // 'admin' = global resource visible to all instructors
  // 'instructor' = per-group resource uploaded by an instructor
  scope:             { type: String, enum: ['admin', 'instructor'], required: true },
  group:             { type: mongoose.Schema.Types.ObjectId, ref: 'Group', default: null },
}, { timestamps: true });

resourceSchema.index({ scope: 1 });
resourceSchema.index({ group: 1 });
resourceSchema.index({ uploadedBy: 1 });

export default mongoose.model('Resource', resourceSchema);
