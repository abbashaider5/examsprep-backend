import express from 'express';
import { downloadCertificate, getMyCertificates, verifyCertificate } from '../controllers/certificateController.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

router.get('/verify/:certId', verifyCertificate);
router.use(protect);
router.get('/', getMyCertificates);
router.get('/download/:certId', downloadCertificate);

export default router;
