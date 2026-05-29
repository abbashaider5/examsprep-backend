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
router.use(protect);

router.post('/import-text', importResourceText);
router.post('/upload-bytes', uploadResourceBytes);
router.post('/', upload.single('file'), uploadResource);
router.get('/admin', getAdminResources);
router.get('/mine', getMyResources);
router.get('/group/:groupId', getGroupResources);
router.get('/:id/processing-status', getResourceProcessingStatus);
router.post('/:id/retry-processing', retryResourceProcessing);
router.get('/:id/text', getResourceText);
router.delete('/:id', deleteResource);

export default router;
