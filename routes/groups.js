import express from 'express';
import {
  acceptGroupInvite,
  adminDeleteGroup,
  adminGetAll,
  cancelInvite,
  createGroup,
  declineGroupInvite,
  deleteGroup,
  deleteMessage,
  editMessage,
  getGroup,
  getGroupInvites,
  getMessages,
  getMyGroupInvites,
  getMyGroups,
  inviteMember,
  leaveGroup,
  removeMember,
  sendMessage,
  shareExam,
  unshareExam,
  updateGroup,
  updateGroupSettings,
  validateGroupInvite,
} from '../controllers/groupController.js';
import { protect, requireAdmin } from '../middleware/auth.js';

const router = express.Router();

// ── Public: invite token validation ──────────────────────────────────────────
router.get('/invite/:token/validate', validateGroupInvite);

router.use(protect);

// ── Admin ─────────────────────────────────────────────────────────────────────
router.get('/admin',        requireAdmin, adminGetAll);
router.delete('/admin/:id', requireAdmin, adminDeleteGroup);

// ── My invites (for any logged-in user) ───────────────────────────────────────
router.get('/my-invites',               getMyGroupInvites);
router.post('/invite/:token/accept',    acceptGroupInvite);
router.post('/invite/:token/decline',   declineGroupInvite);

// ── Group CRUD ────────────────────────────────────────────────────────────────
router.get('/',    getMyGroups);
router.post('/',   createGroup);
router.get('/:id',     getGroup);
router.put('/:id',     updateGroup);
router.delete('/:id',  deleteGroup);

// ── Settings ──────────────────────────────────────────────────────────────────
router.patch('/:id/settings', updateGroupSettings);

// ── Members ───────────────────────────────────────────────────────────────────
router.post('/:id/invite',              inviteMember);
router.get('/:id/invites',              getGroupInvites);
router.delete('/:id/invites/:inviteId', cancelInvite);
router.delete('/:id/members/:userId',   removeMember);
router.post('/:id/leave',               leaveGroup);

// ── Shared exams ──────────────────────────────────────────────────────────────
router.post('/:id/share-exam',           shareExam);
router.delete('/:id/share-exam/:examId', unshareExam);

// ── Chat ──────────────────────────────────────────────────────────────────────
router.get('/:id/messages',           getMessages);
router.post('/:id/messages',          sendMessage);
router.patch('/:id/messages/:msgId',  editMessage);
router.delete('/:id/messages/:msgId', deleteMessage);

export default router;
