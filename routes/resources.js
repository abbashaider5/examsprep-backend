import express from 'express';
import multer from 'multer';
import {
    deleteResource,
    getAdminResources, getGroupResources,
    getMyResources,
    getResourceText,
    uploadResource,
} from '../controllers/resourceController.js';
import { protect } from '../middleware/auth.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (_, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
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
router.get('/:id/text', getResourceText);
router.delete('/:id', deleteResource);

export default router;
