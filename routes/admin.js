import express from 'express';
import {
  deleteUser, getAdminSubscriptions, getAdminTransactions,
  getPublicExams, getStats, getUsers, toggleBlockUser,
  updateUserPlan, updateUserRole,
} from '../controllers/adminController.js';
import {
  deleteContact,
  getContacts,
  replyToContact,
  updateContactStatus,
} from '../controllers/contactController.js';
import { protect, requireAdmin } from '../middleware/auth.js';

const router = express.Router();

router.use(protect, requireAdmin);
router.get('/stats', getStats);
router.get('/users', getUsers);
router.patch('/users/:id/role', updateUserRole);
router.patch('/users/:id/block', toggleBlockUser);
router.patch('/users/:id/plan', updateUserPlan);
router.delete('/users/:id', deleteUser);
router.get('/exams/public', getPublicExams);
router.get('/transactions', getAdminTransactions);
router.get('/subscriptions', getAdminSubscriptions);

// Contact query management --
router.get('/contacts', getContacts);
router.patch('/contacts/:id/status', updateContactStatus);
router.post('/contacts/:id/reply', replyToContact);
router.delete('/contacts/:id', deleteContact);

export default router;
