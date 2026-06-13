import {
  deleteExamAccessKey,
  enrollStudentWithAccessKey,
  getExamAccessKeyForInstructor,
  previewAccessKeyEnrollment,
  upsertExamAccessKey,
} from '../services/examAccessKeyService.js';

export const getExamAccessKey = async (req, res, next) => {
  try {
    const data = await getExamAccessKeyForInstructor(req.params.examId, req.user);
    res.json(data);
  } catch (err) { next(err); }
};

export const saveExamAccessKey = async (req, res, next) => {
  try {
    const { enrollmentLimit, isActive, regenerateKey } = req.body;
    const data = await upsertExamAccessKey(req.params.examId, req.user, {
      enrollmentLimit,
      isActive,
      regenerateKey: Boolean(regenerateKey),
    });
    res.json(data);
  } catch (err) { next(err); }
};

export const removeExamAccessKey = async (req, res, next) => {
  try {
    const data = await deleteExamAccessKey(req.params.examId, req.user);
    res.json(data);
  } catch (err) { next(err); }
};

export const previewAccessKey = async (req, res, next) => {
  try {
    const { accessKey } = req.body;
    const data = await previewAccessKeyEnrollment(req.user, accessKey);
    res.json(data);
  } catch (err) { next(err); }
};

export const enrollViaAccessKey = async (req, res, next) => {
  try {
    const { accessKey } = req.body;
    const data = await enrollStudentWithAccessKey(req.user, accessKey);
    res.status(201).json(data);
  } catch (err) { next(err); }
};
