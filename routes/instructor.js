import express from 'express';
import {
  acceptInvite, becomeInstructor, getDetailedAnalytics, getExamInvites, getExamReport,
  getExamScreenshots, getInstructorAnalytics, getMyAcceptedInvites,
  getMyExams, getMyPendingInvites, rejectInvite, sendGroupInvite, sendInvite, validateInviteToken,
} from '../controllers/instructorController.js';
import { protect, requireInstructor } from '../middleware/auth.js';

const router = express.Router();

// Public: validate invite token
router.get('/invite/:token/validate', validateInviteToken);

// Authenticated (any logged-in user)
router.post('/become', protect, becomeInstructor);
router.post('/invite/:token/accept', protect, acceptInvite);
router.post('/invite/:token/reject', protect, rejectInvite);
router.get('/my-invites', protect, getMyPendingInvites);
router.get('/my-accepted-invites', protect, getMyAcceptedInvites);

// Instructor-only routes
router.use(protect, requireInstructor);
router.get('/exams', getMyExams);
router.post('/exams/:examId/invite', sendInvite);
router.post('/exams/:examId/invite-group', sendGroupInvite);
router.get('/exams/:examId/invites', getExamInvites);
router.get('/exams/:examId/report', getExamReport);
router.get('/exams/:examId/screenshots', getExamScreenshots);
router.get('/analytics', getInstructorAnalytics);
router.get('/analytics/detailed', getDetailedAnalytics);

export default router;
