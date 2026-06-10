import express from 'express';
import {
  acceptInvite, becomeInstructor, getDetailedAnalytics, getExamInvites, getExamReport,
  getExamScreenshots, getInstructorAnalytics, getMyAcceptedInvites, getStudentExamReport,
  getMyExams, getMyPendingInvites, reevaluateResult, rejectInvite, sendClassInvite, sendGroupInvite, sendInvite, validateInviteToken,
} from '../controllers/instructorController.js';
import {
  enrollViaAccessKey, getExamAccessKey, removeExamAccessKey, saveExamAccessKey,
} from '../controllers/examAccessKeyController.js';
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
router.post('/access-keys/enroll', protect, enrollViaAccessKey);

// Instructor-only routes
router.use(protect, requireInstructor);
router.get('/exams', getMyExams);
router.post('/exams/:examId/invite', sendInvite);
router.post('/exams/:examId/invite-group', sendGroupInvite);
router.post('/exams/:examId/invite-class', sendClassInvite);
router.get('/exams/:examId/access-key', getExamAccessKey);
router.put('/exams/:examId/access-key', saveExamAccessKey);
router.delete('/exams/:examId/access-key', removeExamAccessKey);
router.get('/exams/:examId/invites', getExamInvites);
router.get('/exams/:examId/report', getExamReport);
router.get('/exams/:examId/screenshots', getExamScreenshots);
router.get('/exams/:examId/students/:userId/report', getStudentExamReport);
router.get('/analytics', getInstructorAnalytics);
router.get('/analytics/detailed', getDetailedAnalytics);
router.patch('/results/:resultId/reevaluate', reevaluateResult);

export default router;
