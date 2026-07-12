import logger from '../utils/logger.js';
import { AI_USER_FACING, isAiRelatedError } from '../constants/aiUserMessages.js';
import { sanitizeUserFacingText } from '../services/ai/aiProviderErrors.js';

function isPlatformAdmin(req) {
  return req.user?.role === 'admin';
}

function buildAdminAiPayload(err) {
  const d = err.diagnostics || err.aiDiagnostics || null;
  return {
    code: err.publicCode || 'AI_SERVICE_UNAVAILABLE',
    message: err.message,
    userFacingAi: false,
    adminOnly: true,
    aiDiagnostics: d || {
      errorType: err.name,
      errorCode: err.publicCode || '',
      message: err.message,
      stackTrace: err.stack,
    },
  };
}

export const errorHandler = (err, req, res, next) => {
  const admin = isPlatformAdmin(req);

  if (isAiRelatedError(err)) {
    logger.error('[ai] request failure', {
      userId: req.user?._id,
      role: req.user?.role,
      code: err.publicCode,
      provider: err.diagnostics?.provider,
      errorType: err.diagnostics?.errorType,
      errorCode: err.diagnostics?.errorCode,
      model: err.diagnostics?.model,
      message: err.diagnostics?.message || err.message,
      rawResponse: err.diagnostics?.rawResponse,
      stack: err.stack,
    });

    const status = err.statusCode || 503;

    if (admin) {
      return res.status(status).json(buildAdminAiPayload(err));
    }

    return res.status(status).json({
      title: AI_USER_FACING.title,
      message: AI_USER_FACING.message,
      helperText: AI_USER_FACING.helperText,
      code: AI_USER_FACING.code,
      userFacingAi: true,
    });
  }

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
        message: 'File is too large (max 20 MB).',
        code: 'FILE_TOO_LARGE',
      });
    }
    return res.status(400).json({ message: err.message || 'Upload error', code: err.code });
  }

  const status = err.statusCode || 500;
  let message = err.message || 'Internal server error';

  if (!admin) {
    message = sanitizeUserFacingText(message);
    if (!message || status === 500) {
      message = process.env.NODE_ENV === 'production' ? 'Internal server error' : (err.message || 'Internal server error');
    }
    if (status === 500 && process.env.NODE_ENV === 'production' && !message) {
      message = 'Internal server error';
    }
  } else if (status === 500 && process.env.NODE_ENV === 'production' && !err.exposeMessage) {
    message = err.message || 'Internal server error';
  }

  const payload = { message };
  if (err.publicCode && admin) payload.code = err.publicCode;
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
