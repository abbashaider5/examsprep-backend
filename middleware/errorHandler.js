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

  const status = err.statusCode || 500;
  const message = status === 500 && process.env.NODE_ENV === 'production'
    ? 'Internal server error'
    : err.message || 'Internal server error';

  const payload = { message };
  if (err.publicCode) payload.code = err.publicCode;
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
