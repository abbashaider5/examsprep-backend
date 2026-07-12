import crypto from 'crypto';
import { AppError } from '../middleware/errorHandler.js';
import Exam from '../models/Exam.js';
import ExamAccessKey from '../models/ExamAccessKey.js';
import ExamInvite from '../models/ExamInvite.js';
import Enterprise from '../models/Enterprise.js';
import User from '../models/User.js';
import { createNotificationsForUsers } from '../controllers/notificationController.js';
import { delCache } from '../services/cacheService.js';
import { getUserPlanLimits } from '../services/userPlanLimitsService.js';
import logger from '../utils/logger.js';

const KEY_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function randomKeySegment(length = 6) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += KEY_CHARS[bytes[i] % KEY_CHARS.length];
  }
  return out;
}

function buildKeyPrefix(title = '') {
  const cleaned = String(title).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const prefix = (cleaned.slice(0, 4) || 'EXAM').padEnd(4, 'X');
  return prefix;
}

export async function generateUniqueAccessKey(title) {
  const prefix = buildKeyPrefix(title);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const candidate = `${prefix}-${randomKeySegment(6)}`;
    const exists = await ExamAccessKey.exists({ accessKey: candidate });
    if (!exists) return candidate;
  }
  return `${prefix}-${randomKeySegment(8)}`;
}

export async function getInstructorEnrollmentQuota(user) {
  const acceptedDistinct = await ExamInvite.distinct('email', {
    invitedBy: user._id,
    status: 'accepted',
  });
  const used = acceptedDistinct.length;

  if (user.enterpriseId) {
    const ent = await Enterprise.findById(user.enterpriseId).select('studentLimit').lean();
    const cap = Math.max(1, Number(ent?.studentLimit) || 2000);
    return { maxAllowed: cap, used, remaining: Math.max(0, cap - used) };
  }

  const limits = await getUserPlanLimits(user);
  const allowed = Number(limits?.studentsAllowed) || 0;
  if (allowed > 0) {
    return { maxAllowed: allowed, used, remaining: Math.max(0, allowed - used) };
  }

  const practicalCap = 10000;
  return { maxAllowed: practicalCap, used, remaining: Math.max(0, practicalCap - used) };
}

async function assertExamOwner(examId, userId) {
  const exam = await Exam.findOne({ _id: examId, createdBy: userId });
  if (!exam) throw new AppError('Exam not found or unauthorized', 404);
  return exam;
}

function pickVariantIndex(exam) {
  const numVariants = exam.multipleSets && Array.isArray(exam.questionVariants) && exam.questionVariants.length > 0
    ? exam.questionVariants.length
    : 1;
  return numVariants > 1 ? crypto.randomInt(0, numVariants) : 0;
}

export async function getExamAccessKeyForInstructor(examId, user) {
  await assertExamOwner(examId, user._id);
  const keyDoc = await ExamAccessKey.findOne({ exam: examId }).lean();
  const quota = await getInstructorEnrollmentQuota(user);
  if (!keyDoc) {
    return { accessKey: null, quota };
  }
  return {
    accessKey: {
      ...keyDoc,
      remainingSeats: Math.max(0, keyDoc.enrollmentLimit - keyDoc.enrolledCount),
    },
    quota,
  };
}

export async function upsertExamAccessKey(examId, user, { enrollmentLimit, isActive = true, regenerateKey = false }) {
  const exam = await assertExamOwner(examId, user._id);
  const quota = await getInstructorEnrollmentQuota(user);
  const limit = Math.max(1, Math.floor(Number(enrollmentLimit) || 1));

  let keyDoc = await ExamAccessKey.findOne({ exam: examId });
  const maxAllowedLimit = keyDoc
    ? keyDoc.enrolledCount + quota.remaining
    : quota.remaining;

  if (limit > maxAllowedLimit) {
    throw new AppError(
      `Enrollment limit cannot exceed ${maxAllowedLimit} (${quota.remaining} seats remaining in your quota).`,
      400,
    );
  }
  if (keyDoc && limit < keyDoc.enrolledCount) {
    throw new AppError(`Enrollment limit cannot be less than current enrollments (${keyDoc.enrolledCount}).`, 400);
  }

  if (!keyDoc) {
    if (quota.remaining < 1) {
      throw new AppError('You have reached your student enrollment quota.', 403);
    }
    const accessKey = await generateUniqueAccessKey(exam.title);
    keyDoc = await ExamAccessKey.create({
      exam: exam._id,
      instructorId: user._id,
      accessKey,
      enrollmentLimit: limit,
      enrolledCount: 0,
      isActive: Boolean(isActive),
    });
  } else {
    if (regenerateKey) {
      keyDoc.accessKey = await generateUniqueAccessKey(exam.title);
    }
    keyDoc.enrollmentLimit = limit;
    keyDoc.isActive = Boolean(isActive);
    await keyDoc.save();
  }

  await delCache(`analytics:${user._id}`, `instructor_exams:${user._id}`).catch(() => {});

  return {
    accessKey: {
      ...keyDoc.toObject(),
      remainingSeats: Math.max(0, keyDoc.enrollmentLimit - keyDoc.enrolledCount),
    },
    quota,
  };
}

export async function deleteExamAccessKey(examId, user) {
  await assertExamOwner(examId, user._id);
  const keyDoc = await ExamAccessKey.findOneAndDelete({ exam: examId });
  if (!keyDoc) throw new AppError('No access key found for this exam', 404);
  await delCache(`analytics:${user._id}`, `instructor_exams:${user._id}`).catch(() => {});
  return { message: 'Access key deleted' };
}

function examTypeLabel(exam) {
  if (exam.examType === 'descriptive') return 'Descriptive';
  if (exam.examType === 'mixed') return 'Mixed';
  if (exam.examType === 'coding' || exam.enableCoding) return 'Coding';
  return 'MCQ';
}

async function resolveAccessKeyForStudent(user, rawKey) {
  if (user.role !== 'user') {
    throw new AppError('Only student accounts can enroll with an access key.', 403);
  }

  const normalized = String(rawKey || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!normalized || normalized.length < 4) {
    throw new AppError('Invalid exam access key.', 400);
  }

  const keyDoc = await ExamAccessKey.findOne({ accessKey: normalized }).populate(
    'exam',
    'title subject difficulty proctored questions multipleSets questionVariants expiryDate createdBy examType timePerQuestion enableCoding',
  );
  if (!keyDoc) throw new AppError('Invalid exam access key.', 404);
  if (!keyDoc.isActive) throw new AppError('This exam key is currently inactive.', 403);
  if (keyDoc.enrolledCount >= keyDoc.enrollmentLimit) {
    throw new AppError('This exam has reached its maximum enrollment capacity.', 403);
  }

  const exam = keyDoc.exam;
  if (!exam) throw new AppError('Exam not found', 404);
  if (exam.expiryDate && new Date(exam.expiryDate) < new Date()) {
    throw new AppError('This test has expired', 403);
  }

  const email = user.email.toLowerCase();
  const existing = await ExamInvite.findOne({
    exam: exam._id,
    email,
    status: { $in: ['pending', 'accepted'] },
  });
  if (existing) {
    throw new AppError('You are already enrolled in this exam.', 409);
  }

  return { normalized, keyDoc, exam, email };
}

export async function previewAccessKeyEnrollment(user, rawKey) {
  const { normalized, keyDoc, exam } = await resolveAccessKeyForStudent(user, rawKey);
  const instructor = await User.findById(keyDoc.instructorId).select('name isInstructorVerified aboutMe').lean();
  const questionCount = exam.questions?.length || 0;
  const totalSeconds = questionCount * (exam.timePerQuestion || 60);

  return {
    accessKey: normalized,
    exam: {
      _id: exam._id,
      title: exam.title,
      subject: exam.subject,
      difficulty: exam.difficulty,
      examType: exam.examType,
      examTypeLabel: examTypeLabel(exam),
      questionCount,
      durationMinutes: Math.max(1, Math.ceil(totalSeconds / 60)),
      expiryDate: exam.expiryDate || null,
    },
    instructorName: instructor?.name || 'Instructor',
    instructorVerified: !!instructor?.isInstructorVerified,
    instructorAboutMe: instructor?.aboutMe || '',
    instructor: {
      name: instructor?.name || 'Instructor',
      isVerified: !!instructor?.isInstructorVerified,
      aboutMe: instructor?.aboutMe || '',
    },
    seatsRemaining: Math.max(0, keyDoc.enrollmentLimit - keyDoc.enrolledCount),
  };
}

export async function enrollStudentWithAccessKey(user, rawKey) {
  const { keyDoc, exam, email } = await resolveAccessKeyForStudent(user, rawKey);

  const updatedKey = await ExamAccessKey.findOneAndUpdate(
    {
      _id: keyDoc._id,
      isActive: true,
      $expr: { $lt: ['$enrolledCount', '$enrollmentLimit'] },
    },
    { $inc: { enrolledCount: 1 } },
    { new: true },
  );
  if (!updatedKey) {
    throw new AppError('This exam has reached its maximum enrollment capacity.', 403);
  }

  const instructor = await User.findById(keyDoc.instructorId).select('name').lean();
  const assignedVariantIndex = pickVariantIndex(exam);

  let invite;
  try {
    invite = await ExamInvite.create({
      exam: exam._id,
      invitedBy: keyDoc.instructorId,
      email,
      status: 'accepted',
      assignedVariantIndex,
      enrollmentSource: 'access_key',
      accessKeyRef: keyDoc._id,
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    });
  } catch (err) {
    await ExamAccessKey.updateOne({ _id: keyDoc._id }, { $inc: { enrolledCount: -1 } });
    throw err;
  }

  createNotificationsForUsers([user._id], {
    type: 'exam_invite',
    title: 'Enrolled in test',
    message: `You're enrolled for "${exam.title}". Start it from My Tests when you're ready.`,
    link: '/tests',
    severity: 'info',
    meta: { examId: exam._id.toString() },
  }).catch(logger.error);

  if (updatedKey.enrolledCount >= updatedKey.enrollmentLimit) {
    createNotificationsForUsers([keyDoc.instructorId], {
      type: 'general',
      title: 'Access key enrollment limit reached',
      message: `Your exam access key for "${exam.title}" has reached its enrollment limit.`,
      link: '/instructor-dashboard',
      severity: 'info',
      meta: { examId: exam._id.toString(), accessKeyId: keyDoc._id.toString() },
    }).catch(logger.error);
  }

  return {
    message: 'Successfully enrolled in exam.',
    exam: {
      _id: exam._id,
      title: exam.title,
      subject: exam.subject,
      difficulty: exam.difficulty,
      proctored: exam.proctored,
    },
    invite,
    instructorName: instructor?.name || 'Instructor',
  };
}

export async function getAccessKeysByExamIds(examIds) {
  if (!examIds?.length) return {};
  const keys = await ExamAccessKey.find({ exam: { $in: examIds }, isActive: true }).lean();
  return Object.fromEntries(keys.map((k) => [k.exam.toString(), {
    accessKey: k.accessKey,
    enrollmentLimit: k.enrollmentLimit,
    enrolledCount: k.enrolledCount,
    remainingSeats: Math.max(0, k.enrollmentLimit - k.enrolledCount),
    isActive: k.isActive,
  }]));
}
