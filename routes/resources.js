import express from 'express';
import multer from 'multer';
import { RESOURCE_UPLOAD_MAX_BYTES } from '../config/uploadLimits.js';
import {
  deleteResource,
  getAdminResources, getGroupResources,
  getMyResources,
  getResourceProcessingStatus,
  getResourceText,
  retryResourceProcessing,
  importResourceText,
  uploadResource,
  uploadResourceBytes,
} from '../controllers/resourceController.js';
import { protect } from '../middleware/auth.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: RESOURCE_UPLOAD_MAX_BYTES,
    fieldSize: 12 * 1024 * 1024,
  },
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
router.use(protect);

/** Vercel proxy may mangle ?import=text into ?import-text — accept both. */
export function wantsPdfTextImport(req) {
  if (req.query.import === 'text') return true;
  if (Object.prototype.hasOwnProperty.call(req.query, 'import-text')) return true;
  if (req.get('x-resource-import') === 'text') return true;
  if (req.body?.importMode === 'text') return true;
  return false;
}

const parseTextFields = upload.none();

/** Shared POST /api/resources — PDF text fields or multipart file upload. */
export const handleResourceCreatePost = (req, res, next) => {
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  const textImport = wantsPdfTextImport(req);

  if (textImport && ct.includes('multipart/form-data')) {
    return parseTextFields(req, res, (err) => {
      if (err) return next(err);
      return importResourceText(req, res, next);
    });
  }

  if (textImport) {
    return importResourceText(req, res, next);
  }

  return upload.single('file')(req, res, (err) => {
    if (err) return next(err);
    uploadResource(req, res, next);
  });
};

/** Dedicated path (avoids query-string mangling on Vercel rewrites). */
export const handleResourceFromTextPost = (req, res, next) => {
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (ct.includes('multipart/form-data')) {
    return parseTextFields(req, res, (err) => {
      if (err) return next(err);
      return importResourceText(req, res, next);
    });
  }
  return importResourceText(req, res, next);
};

router.post('/from-text', handleResourceFromTextPost);
router.post('/import-text', handleResourceFromTextPost);
router.post('/upload-bytes', uploadResourceBytes);
router.get('/admin', getAdminResources);
router.get('/mine', getMyResources);
router.get('/group/:groupId', getGroupResources);
router.get('/:id/processing-status', getResourceProcessingStatus);
router.post('/:id/retry-processing', retryResourceProcessing);
router.get('/:id/text', getResourceText);
router.delete('/:id', deleteResource);

export default router;
