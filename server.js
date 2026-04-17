import cookieParser from 'cookie-parser';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import mongoSanitize from 'express-mongo-sanitize';
import helmet from 'helmet';
import morgan from 'morgan';

dotenv.config();

import { validateEnv } from './utils/validateEnv.js';
validateEnv();

import { connectDB } from './config/db.js';
import { errorHandler } from './middleware/errorHandler.js';
import logger from './utils/logger.js';
import { apiLimiter } from './middleware/rateLimiter.js';
import { getSettings } from './models/SystemSettings.js';

import adminRoutes from './routes/admin.js';
import authRoutes from './routes/auth.js';
import certificateRoutes from './routes/certificate.js';
import examRoutes from './routes/exam.js';
import leaderboardRoutes from './routes/leaderboard.js';
import logsRoutes from './routes/logs.js';
import profileRoutes from './routes/profile.js';
import resultRoutes from './routes/result.js';
import settingsRoutes from './routes/settings.js';
import paymentRoutes from './routes/payment.js';
import instructorRoutes from './routes/instructor.js';

const app = express();
connectDB();

app.use(helmet({ crossOriginEmbedderPolicy: false, contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:5173',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(process.env.COOKIE_SECRET));
app.use(mongoSanitize());

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev', { stream: { write: (msg) => logger.http(msg.trim()) } }));
}

// Maintenance mode check (excluding admin/auth/health)
app.use(async (req, res, next) => {
  const bypass = req.path.startsWith('/api/auth') || req.path.startsWith('/api/admin') || req.path === '/api/health' || req.path.startsWith('/api/settings/public');
  if (bypass) return next();
  try {
    const settings = await getSettings();
    if (settings.maintenanceMode) {
      return res.status(503).json({ maintenance: true, message: settings.maintenanceMessage });
    }
  } catch {}
  next();
});

app.use('/api', apiLimiter);
app.use('/api/auth', authRoutes);
app.use('/api/exams', examRoutes);
app.use('/api/results', resultRoutes);
app.use('/api/certificates', certificateRoutes);
app.use('/api/leaderboard', leaderboardRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/logs', logsRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/instructor', instructorRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'ok', env: process.env.NODE_ENV, time: new Date().toISOString() }));
app.use('*', (req, res) => res.status(404).json({ message: `Route ${req.originalUrl} not found` }));
app.use(errorHandler);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => logger.info(`🚀 Server running on port ${PORT} [${process.env.NODE_ENV}]`));

export default app;
