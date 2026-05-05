import mongoose from 'mongoose';

const sectionSchema = new mongoose.Schema(
  {
    heading: { type: String, required: true, trim: true },
    paragraphs: [{ type: String }],
    bullets: [{ type: String }],
  },
  { _id: false }
);

const helpTopicSchema = new mongoose.Schema(
  {
    topicId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      maxlength: 120,
      match: /^[a-z0-9][a-z0-9-]*$/,
    },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, required: true, trim: true, maxlength: 500 },
    category: { type: String, required: true, trim: true, maxlength: 80 },
    keywords: [{ type: String, trim: true }],
    sections: { type: [sectionSchema], required: true, validate: [(v) => v?.length > 0, 'At least one section'] },
    /** Optional YouTube watch / share URL — validated on write */
    videoUrl: { type: String, default: '', trim: true, maxlength: 500 },
    audience: {
      type: String,
      required: true,
      enum: ['user', 'instructor', 'admin'],
    },
  },
  { timestamps: true }
);

helpTopicSchema.index({ audience: 1, category: 1 });

export default mongoose.model('HelpTopic', helpTopicSchema);
