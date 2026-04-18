import express from 'express';
import {
  submitContact,
  getContacts,
  updateContactStatus,
  replyToContact,
  deleteContact,
} from '../controllers/contactController.js';
import { protect, requireAdmin } from '../middleware/auth.js';

const router = express.Router();

// Public: submit contact form
router.post('/', submitContact);

// Admin: manage contact queries
router.get('/', protect, requireAdmin, getContacts);
router.patch('/:id/status', protect, requireAdmin, updateContactStatus);
router.post('/:id/reply', protect, requireAdmin, replyToContact);
router.delete('/:id', protect, requireAdmin, deleteContact);

export default router;
