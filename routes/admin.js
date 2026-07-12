import express from 'express';
import multer from 'multer';
import {
  createUser, deleteUser, getAdminSubscriptions, getAdminTransactions,
  getPublicExams, getStats, getUsers, toggleBlockUser, toggleInstructorVerified,
  updateUserPlan, updateUserRole,
} from '../controllers/adminController.js';
import {
  deleteContact,
  getContacts,
  replyToContact,
  updateContactStatus,
} from '../controllers/contactController.js';
import { adminListResources, adminUpdateResource, deleteResource, uploadResource } from '../controllers/resourceController.js';
import {
  createHelpTopic,
  deleteHelpTopic,
  listHelpTopicsAdmin,
  updateHelpTopic,
} from '../controllers/helpTopicController.js';
import { getActiveAiHealth, getAiIncidentDetail, getLastAiRequestTrace, listAiIncidents } from '../controllers/aiHealthController.js';
import { createPlan, deletePlan, listAdminPlans, updatePlan } from '../controllers/planController.js';
import { protect, requireAdmin } from '../middleware/auth.js';
import { RESOURCE_UPLOAD_MAX_BYTES } from '../config/uploadLimits.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: RESOURCE_UPLOAD_MAX_BYTES },
  fileFilter: (_, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.ms-powerpoint',
      'text/plain',
    ];
    cb(null, allowed.includes(file.mimetype));
  },
});

const router = express.Router();

router.use(protect, requireAdmin);
router.get('/stats', getStats);
router.get('/ai-health/active', getActiveAiHealth);
router.get('/ai-health/last-trace', getLastAiRequestTrace);
router.get('/ai-health/incidents', listAiIncidents);
router.get('/ai-health/incidents/:id', getAiIncidentDetail);
router.get('/users', getUsers);
router.post('/users', createUser);
router.patch('/users/:id/role', updateUserRole);
router.patch('/users/:id/block', toggleBlockUser);
router.patch('/users/:id/verify', toggleInstructorVerified);
router.patch('/users/:id/plan', updateUserPlan);
router.delete('/users/:id', deleteUser);
router.get('/exams/public', getPublicExams);
router.get('/transactions', getAdminTransactions);
router.get('/subscriptions', getAdminSubscriptions);
router.get('/plans', listAdminPlans);
router.post('/plans', createPlan);
router.put('/plans/:id', updatePlan);
router.delete('/plans/:id', deletePlan);

// Contact query management
router.get('/contacts', getContacts);
router.patch('/contacts/:id/status', updateContactStatus);
router.post('/contacts/:id/reply', replyToContact);
router.delete('/contacts/:id', deleteContact);

// Resource / Books management (admin uploads)
router.get('/resources', adminListResources);
router.post('/resources', upload.single('file'), uploadResource);
router.patch('/resources/:id', adminUpdateResource);
router.delete('/resources/:id', deleteResource);

// Help center articles (CRUD)
router.get('/help/topics', listHelpTopicsAdmin);
router.post('/help/topics', createHelpTopic);
router.put('/help/topics/:topicId', updateHelpTopic);
router.delete('/help/topics/:topicId', deleteHelpTopic);

export default router;

