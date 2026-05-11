import express from 'express';
import {
  acceptEnterpriseInviteLoggedIn,
  adminCreateEnterprise,
  adminDeleteEnterprise,
  adminGetAllEnterpriseLogs,
  adminGetEnterpriseLogs,
  adminListEnterprises,
  adminUpdateEnterprise,
  adminUpdateEnterpriseTeacherLimit,
  enterpriseCreateClass,
  enterpriseUpdateClass,
  enterpriseDeleteClass,
  enterpriseBulkInviteStudents,
  enterpriseGetClassChatGroup,
  enterpriseInviteStudent,
  enterpriseListClasses,
  enterpriseListMySchoolChats,
  enterpriseListStudents,
  enterpriseUpdateStudent,
  enterpriseDeleteStudent,
  principalCancelInvite,
  principalGetContext,
  principalGetLogs,
  principalGetLogStats,
  principalImpersonateTeacher,
  principalInviteTeacher,
  principalListTeachers,
  principalRemoveTeacher,
  principalToggleTeacherBlock,
  principalUpdateTeacher,
  principalStopImpersonation,
} from '../controllers/enterpriseController.js';
import { protect, requireAdmin, requirePrincipal } from '../middleware/auth.js';

const router = express.Router();

router.post('/invites/:token/accept', protect, acceptEnterpriseInviteLoggedIn);

router.get('/principal/context', protect, requirePrincipal, principalGetContext);
router.get('/principal/logs', protect, requirePrincipal, principalGetLogs);
router.get('/principal/logs/stats', protect, requirePrincipal, principalGetLogStats);
router.post('/principal/teachers/invite', protect, requirePrincipal, principalInviteTeacher);
router.get('/principal/teachers', protect, requirePrincipal, principalListTeachers);
router.patch('/principal/teachers/:teacherId', protect, requirePrincipal, principalUpdateTeacher);
router.patch('/principal/teachers/:teacherId/block', protect, requirePrincipal, principalToggleTeacherBlock);
router.delete('/principal/teachers/:teacherId', protect, requirePrincipal, principalRemoveTeacher);
router.delete('/principal/invites/:inviteId', protect, requirePrincipal, principalCancelInvite);
router.post('/principal/impersonate/:teacherId', protect, requirePrincipal, principalImpersonateTeacher);
router.post('/principal/stop-impersonation', protect, principalStopImpersonation);

router.get('/school/classes', protect, enterpriseListClasses);
router.post('/school/classes', protect, enterpriseCreateClass);
router.get('/school/classes/:classId/chat-group', protect, enterpriseGetClassChatGroup);
router.patch('/school/classes/:classId', protect, enterpriseUpdateClass);
router.delete('/school/classes/:classId', protect, enterpriseDeleteClass);
router.get('/school/my-chats', protect, enterpriseListMySchoolChats);
router.get('/school/students', protect, enterpriseListStudents);
router.patch('/school/students/:userId', protect, enterpriseUpdateStudent);
router.delete('/school/students/:userId', protect, enterpriseDeleteStudent);
router.post('/school/students', protect, enterpriseInviteStudent);
router.post('/school/students/bulk', protect, enterpriseBulkInviteStudents);

router.get('/admin/list', protect, requireAdmin, adminListEnterprises);
router.post('/admin/create', protect, requireAdmin, adminCreateEnterprise);
router.get('/admin/logs', protect, requireAdmin, adminGetAllEnterpriseLogs);
router.patch('/admin/:id/teacher-limit', protect, requireAdmin, adminUpdateEnterpriseTeacherLimit);
router.patch('/admin/:id', protect, requireAdmin, adminUpdateEnterprise);
router.delete('/admin/:id', protect, requireAdmin, adminDeleteEnterprise);
router.get('/admin/:id/logs', protect, requireAdmin, adminGetEnterpriseLogs);

export default router;
