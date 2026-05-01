import { AppError } from '../middleware/errorHandler.js';
import Ticket, { TICKET_STATUSES, TICKET_TYPES } from '../models/Ticket.js';
import { uploadTicketAttachment } from '../services/cloudinaryService.js';

const parsePage = (value, fallback = 1) => Math.max(1, parseInt(value, 10) || fallback);

export const createTicket = async (req, res, next) => {
  try {
    const { title, description, type } = req.body;
    if (!title?.trim() || !description?.trim() || !type) {
      return next(new AppError('Title, description and ticket type are required.', 400));
    }
    if (!TICKET_TYPES.includes(type)) {
      return next(new AppError('Invalid ticket type.', 400));
    }

    let attachment = null;
    if (req.file) {
      attachment = await uploadTicketAttachment(req.file.buffer, req.file.mimetype, req.file.originalname);
    }

    const ticket = await Ticket.create({
      user: req.user._id,
      title: title.trim(),
      description: description.trim(),
      type,
      attachment: attachment || undefined,
    });

    res.status(201).json({ message: 'Ticket created successfully.', ticket });
  } catch (err) {
    next(err);
  }
};

export const getMyTickets = async (req, res, next) => {
  try {
    const page = parsePage(req.query.page);
    const limit = 10;
    const query = { user: req.user._id };
    const [tickets, total] = await Promise.all([
      Ticket.find(query).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Ticket.countDocuments(query),
    ]);
    res.json({ tickets, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    next(err);
  }
};

export const getAllTicketsAdmin = async (req, res, next) => {
  try {
    const page = parsePage(req.query.page);
    const limit = 20;
    const { status = '', type = '', search = '', fromDate = '', toDate = '' } = req.query;

    const query = {};
    if (status) query.status = status;
    if (type) query.type = type;
    if (fromDate || toDate) {
      query.createdAt = {};
      if (fromDate) query.createdAt.$gte = new Date(fromDate);
      if (toDate) {
        const end = new Date(toDate);
        end.setHours(23, 59, 59, 999);
        query.createdAt.$lte = end;
      }
    }
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
      ];
    }

    const [tickets, total] = await Promise.all([
      Ticket.find(query)
        .populate('user', 'name email role')
        .populate('respondedBy', 'name email')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Ticket.countDocuments(query),
    ]);

    res.json({ tickets, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    next(err);
  }
};

export const updateTicketAdmin = async (req, res, next) => {
  try {
    const { status, adminResponse } = req.body;
    const updates = {};
    if (status) {
      if (!TICKET_STATUSES.includes(status)) return next(new AppError('Invalid ticket status.', 400));
      updates.status = status;
    }
    if (adminResponse !== undefined) {
      updates.adminResponse = String(adminResponse || '').trim();
      updates.respondedAt = updates.adminResponse ? new Date() : null;
      updates.respondedBy = updates.adminResponse ? req.user._id : null;
    }
    if (Object.keys(updates).length === 0) {
      return next(new AppError('No valid updates provided.', 400));
    }

    const ticket = await Ticket.findByIdAndUpdate(req.params.id, updates, { new: true })
      .populate('user', 'name email role')
      .populate('respondedBy', 'name email');
    if (!ticket) return next(new AppError('Ticket not found.', 404));
    res.json({ message: 'Ticket updated.', ticket });
  } catch (err) {
    next(err);
  }
};
