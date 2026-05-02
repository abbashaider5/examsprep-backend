import express from 'express';
import multer from 'multer';
import {
  createTicket,
  getAllTicketsAdmin,
  getMyTickets,
  updateTicketAdmin,
} from '../controllers/ticketController.js';
import { protect, requireAdmin } from '../middleware/auth.js';

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const allowed = [
      'image/png',
      'image/jpeg',
      'image/jpg',
      'image/webp',
      'image/gif',
    ];
    cb(null, allowed.includes(file.mimetype));
  },
});

router.use(protect);

// Any authenticated user can raise/view their own tickets.
router.post('/', upload.single('attachment'), createTicket);
router.get('/mine', getMyTickets);

router.get('/admin', requireAdmin, getAllTicketsAdmin);
router.patch('/admin/:id', requireAdmin, updateTicketAdmin);

export default router;
