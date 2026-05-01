import mongoose from 'mongoose';

export const TICKET_TYPES = [
  'Test Creation Issue',
  'Student Management Issue',
  'AI Proctoring Issue',
  'Result / Analytics Issue',
  'Payment / Subscription Issue',
  'Platform Bug',
  'Feature Request',
  'Other',
];

export const TICKET_STATUSES = ['open', 'in_progress', 'resolved', 'closed'];

const ticketSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 140 },
    description: { type: String, required: true, trim: true, maxlength: 5000 },
    type: { type: String, enum: TICKET_TYPES, required: true, index: true },
    status: { type: String, enum: TICKET_STATUSES, default: 'open', index: true },
    attachment: {
      url: { type: String, default: null },
      publicId: { type: String, default: null },
      resourceType: { type: String, default: null },
      originalName: { type: String, default: null },
    },
    adminResponse: { type: String, default: '' },
    respondedAt: { type: Date, default: null },
    respondedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

export default mongoose.model('Ticket', ticketSchema);
