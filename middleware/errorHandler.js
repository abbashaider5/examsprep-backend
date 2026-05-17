import logger from '../utils/logger.js';

export const errorHandler = (err, req, res, next) => {
  logger.error(err.stack || err.message);

  if (err.name === 'ValidationError') {
    const errors = Object.values(err.errors).map(e => e.message);
    return res.status(400).json({ message: 'Validation error', errors });
  }
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    return res.status(409).json({ message: `${field} already exists` });
  }
  if (err.name === 'CastError') {
    return res.status(400).json({ message: 'Invalid ID format' });
  }
  if (err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        message: process.env.VERCEL
          ? 'File is too large for production upload (max 4.5 MB). Use a smaller file or Word (.docx).'
          : 'File is too large (max 20 MB).',
        code: 'FILE_TOO_LARGE',
      });
    }
    return res.status(400).json({ message: err.message || 'Upload error', code: err.code });
  }

  const status = err.statusCode || 500;

  const AI_USER_MESSAGES = {
    AI_GENERATION_JSON_FAILED:
      'LikhitAI could not assemble all of your questions in one pass. Large exams are generated in batches; if this persists, try again with slightly fewer questions.',
    AI_GENERATION_EMPTY:
      'LikhitAI did not receive enough questions back from the AI service. Please try again.',
  };

  let message = err.message || 'Internal server error';
  if (err.supportHint && err.publicCode) {
    message = AI_USER_MESSAGES[err.publicCode] || message;
  } else if (status === 500 && process.env.NODE_ENV === 'production') {
    message = 'Internal server error';
  }

  const payload = { message };
  if (err.publicCode) payload.code = err.publicCode;
  if (err.supportHint) payload.supportHint = true;
  if (err.aiKind) payload.aiKind = err.aiKind;
  res.status(status).json(payload);
};

export class AppError extends Error {
  constructor(message, statusCode, opts = {}) {
    super(message);
    this.statusCode = statusCode;
    this.publicCode = opts.code || null;
    Error.captureStackTrace(this, this.constructor);
  }
}
