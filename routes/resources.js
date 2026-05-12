import express from 'express';
import multer from 'multer';
import {
  deleteResource,
  getAdminResources, getGroupResources,
  getMyResources,
  getResourceProcessingStatus,
  getResourceText,
  retryResourceProcessing,
  uploadResource,
} from '../controllers/resourceController.js';
import { protect } from '../middleware/auth.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
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

router.post('/', upload.single('file'), uploadResource);
router.get('/admin', getAdminResources);
router.get('/mine', getMyResources);
router.get('/group/:groupId', getGroupResources);
router.get('/:id/processing-status', getResourceProcessingStatus);
router.post('/:id/retry-processing', retryResourceProcessing);
router.get('/:id/text', getResourceText);
router.delete('/:id', deleteResource);

export default router;
