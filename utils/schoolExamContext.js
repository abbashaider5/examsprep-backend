import Enterprise from '../models/Enterprise.js';
import Resource from '../models/Resource.js';
import { AppError } from '../middleware/errorHandler.js';
import { normalizeBoard, normalizeClassLevel } from '../constants/curriculum.js';

export async function getEnterpriseContext(enterpriseId) {
  if (!enterpriseId) return null;
  return Enterprise.findById(enterpriseId).select('board mode').lean();
}

export function isSchoolEnterpriseInstructor(user, ent) {
  return user?.role === 'instructor' && Boolean(ent) && ent.mode === 'school';
}

export function isInstituteEnterpriseInstructor(user, ent) {
  return user?.role === 'instructor' && Boolean(ent) && ent.mode === 'institute';
}

/** Individual (non-enterprise) instructors. */
export function isIndividualInstructor(user) {
  return user?.role === 'instructor' && !user?.enterpriseId;
}

export function isInstituteIndividualInstructor(user) {
  return isIndividualInstructor(user)
    && String(user?.organizationType || 'school').toLowerCase() === 'institute';
}

export function isSchoolIndividualInstructor(user) {
  return isIndividualInstructor(user) && !isInstituteIndividualInstructor(user);
}

/** School enterprise + individual school: curriculum dropdowns from admin mappings. */
export function usesCurriculumExamWorkflow(user, ent) {
  return isSchoolEnterpriseInstructor(user, ent) || isSchoolIndividualInstructor(user);
}

/** Institute enterprise + individual institute: free-text subject, no board/class. */
export function isInstituteExamWorkflow(user, ent) {
  return isInstituteEnterpriseInstructor(user, ent) || isInstituteIndividualInstructor(user);
}

export function resolveAdditionalAiInstructions(req, exam = null) {
  if (req?.body?.additionalAiInstructions !== undefined) {
    return String(req.body.additionalAiInstructions || '').trim().slice(0, 4000);
  }
  return String(exam?.additionalAiInstructions || '').trim().slice(0, 4000);
}

async function assertCurriculumMapping(board, classLevel, subject) {
  const mapped = await Resource.findOne({
    scope: 'admin',
    board,
    classLevel,
    subject,
  }).select('_id').lean();
  if (!mapped) {
    throw new AppError(
      'Selected subject is not available for this board and class. Ask your admin to upload curriculum resources.',
      400,
    );
  }
}

/**
 * Validates curriculum fields for school / individual instructors.
 * Institute instructors keep free-text subject (no board/class enforcement).
 * @returns {{ board: string, classLevel: string, subject: string }}
 */
export async function resolveExamCurriculumFields(req, user, { subject: subjectIn, classLevel: classLevelIn, board: boardIn }) {
  const ent = await getEnterpriseContext(user.enterpriseId);
  const subject = String(subjectIn || '').trim();

  if (isInstituteExamWorkflow(user, ent)) {
    if (!subject) throw new AppError('Subject is required', 400);
    return { board: '', classLevel: '', subject };
  }

  if (!usesCurriculumExamWorkflow(user, ent)) {
    return { board: '', classLevel: '', subject };
  }

  let board = '';
  let classLevel = '';

  if (isSchoolEnterpriseInstructor(user, ent)) {
    board = ent.board || 'CBSE';
  } else {
    board = normalizeBoard(boardIn);
    if (!board) throw new AppError('Board is required (CBSE or ICSE)', 400);
  }

  classLevel = normalizeClassLevel(classLevelIn);
  if (!classLevel) throw new AppError('Class is required', 400);
  if (!subject) throw new AppError('Subject is required', 400);

  await assertCurriculumMapping(board, classLevel, subject);
  return { board, classLevel, subject };
}

export async function assertResourceMatchesCurriculumExam(resource, { board, classLevel, subject }) {
  if (!board && !classLevel) return;
  if (resource.scope !== 'admin') return;
  if (board && resource.board && resource.board !== board) {
    throw new AppError('This resource does not match the selected board', 403);
  }
  if (classLevel && resource.classLevel && resource.classLevel !== classLevel) {
    throw new AppError('This resource does not match the selected class', 403);
  }
  if (subject && resource.subject && resource.subject.trim().toLowerCase() !== subject.trim().toLowerCase()) {
    throw new AppError('This resource does not match the selected subject', 403);
  }
}

/** @deprecated use assertResourceMatchesCurriculumExam */
export const assertResourceMatchesSchoolExam = assertResourceMatchesCurriculumExam;
