import { AppError } from '../middleware/errorHandler.js';
import Contact from '../models/Contact.js';
import { sendContactReplyEmail } from '../services/emailService.js';

// ── Submit contact query (public) ─────────────────────────────────────────────
export const submitContact = async (req, res, next) => {
  try {
    const { name, email, type, message } = req.body;
    if (!name || !email || !type || !message) {
      return next(new AppError('All fields are required.', 400));
    }
    if (message.length < 10) {
      return next(new AppError('Message must be at least 10 characters.', 400));
    }

    const contact = await Contact.create({
      name: name.trim(),
      email: email.toLowerCase().trim(),
      type,
      message: message.trim(),
      ipAddress: req.ip,
    });

    res.status(201).json({ message: 'Your message has been received. We will get back to you soon.', id: contact._id });
  } catch (err) { next(err); }
};

// ── Get all contact queries (admin) ───────────────────────────────────────────
export const getContacts = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 20;
    const status = req.query.status || '';
    const search = req.query.search || '';

    const query = {};
    if (status) query.status = status;
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { message: { $regex: search, $options: 'i' } },
      ];
    }

    const [contacts, total] = await Promise.all([
      Contact.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Contact.countDocuments(query),
    ]);

    res.json({ contacts, total, page, pages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
};

// ── Update status (admin) ─────────────────────────────────────────────────────
export const updateContactStatus = async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!['pending', 'in_progress', 'resolved'].includes(status)) {
      return next(new AppError('Invalid status.', 400));
    }
    const contact = await Contact.findByIdAndUpdate(req.params.id, { status }, { new: true });
    if (!contact) return next(new AppError('Contact query not found.', 404));
    res.json({ message: 'Status updated.', contact });
  } catch (err) { next(err); }
};

// ── Reply to contact (admin) ──────────────────────────────────────────────────
export const replyToContact = async (req, res, next) => {
  try {
    const { reply } = req.body;
    if (!reply || reply.trim().length < 5) {
      return next(new AppError('Reply must be at least 5 characters.', 400));
    }

    const contact = await Contact.findByIdAndUpdate(
      req.params.id,
      {
        adminReply: reply.trim(),
        repliedAt: new Date(),
        repliedBy: req.user._id,
        status: 'resolved',
      },
      { new: true }
    );
    if (!contact) return next(new AppError('Contact query not found.', 404));

    // Send email reply to user
    sendContactReplyEmail({
      email: contact.email,
      name: contact.name,
      originalMessage: contact.message,
      reply: reply.trim(),
    }).catch(() => {}); // don't fail if email fails

    res.json({ message: 'Reply sent successfully.', contact });
  } catch (err) { next(err); }
};

// ── Delete contact query (admin) ──────────────────────────────────────────────
export const deleteContact = async (req, res, next) => {
  try {
    const contact = await Contact.findByIdAndDelete(req.params.id);
    if (!contact) return next(new AppError('Contact query not found.', 404));
    res.json({ message: 'Contact query deleted.' });
  } catch (err) { next(err); }
};
