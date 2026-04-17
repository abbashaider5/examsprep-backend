import { AppError } from '../middleware/errorHandler.js';
import Certificate from '../models/Certificate.js';
import Result from '../models/Result.js';
import { getSettings } from '../models/SystemSettings.js';
import { generateCertificatePDF } from '../services/pdfService.js';

export const getMyCertificates = async (req, res, next) => {
  try {
    const certs = await Certificate.find({ user: req.user._id }).sort({ issuedAt: -1 });
    res.json({ certificates: certs });
  } catch (err) {
    next(err);
  }
};

export const verifyCertificate = async (req, res, next) => {
  try {
    const cert = await Certificate.findOne({ certId: req.params.certId })
      .populate('user', 'name')
      .populate('exam', 'title subject difficulty');
    if (!cert) return next(new AppError('Certificate not found', 404));
    res.json({ certificate: cert });
  } catch (err) {
    next(err);
  }
};

export const downloadCertificate = async (req, res, next) => {
  try {
    const cert = await Certificate.findOne({ certId: req.params.certId, user: req.user._id })
      .populate('exam', 'difficulty questions');
    if (!cert) return next(new AppError('Certificate not found', 404));

    // Try to get extra details from the linked result
    let timeTaken = null;
    let totalQuestions = cert.exam?.questions?.length || null;
    const difficulty = cert.exam?.difficulty || null;
    if (cert.result) {
      const result = await Result.findById(cert.result).select('timeTaken totalQuestions');
      if (result) {
        timeTaken = result.timeTaken;
        totalQuestions = result.totalQuestions || totalQuestions;
      }
    }

    const settings = await getSettings();
    const pdfBuffer = await generateCertificatePDF({
      userName: cert.userName,
      examName: cert.examName,
      score: cert.score,
      percentage: cert.percentage,
      certId: cert.certId,
      issuedAt: cert.issuedAt,
      proctored: cert.proctored,
      instructorName: cert.instructorName || null,
      certSettings: settings,
      totalQuestions,
      timeTaken,
      difficulty,
    });

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="certificate-${cert.certId}.pdf"`,
      'Content-Length': pdfBuffer.length,
    });
    res.send(pdfBuffer);
  } catch (err) {
    next(err);
  }
};
