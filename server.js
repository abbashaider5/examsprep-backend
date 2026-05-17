import dns from 'node:dns';
/** Prefer IPv4 before first outbound connections (helps Cloudinary/CDN on some Windows dual-stack setups). */
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

import cookieParser from 'cookie-parser';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import mongoSanitize from 'express-mongo-sanitize';
import helmet from 'helmet';
import mongoose from 'mongoose';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { validateEnv } from './utils/validateEnv.js';
validateEnv();

import { connectDB } from './config/db.js';
import { errorHandler } from './middleware/errorHandler.js';
import { apiLimiter } from './middleware/rateLimiter.js';
import { getSettings } from './models/SystemSettings.js';
import logger from './utils/logger.js';
import { seedHelpTopicsIfEmpty } from './utils/seedHelpTopics.js';
import { scheduleProctoringScreenshotCleanup } from './services/proctoringScreenshotRetention.js';
import { corsHeadersMiddleware, createCorsOptions } from './config/cors.js';

import adminRoutes from './routes/admin.js';
import announcementRoutes from './routes/announcements.js';
import authRoutes from './routes/auth.js';
import certificateRoutes from './routes/certificate.js';
import contactRoutes from './routes/contact.js';
import enterpriseRoutes from './routes/enterprise.js';
import examRoutes from './routes/exam.js';
import feedbackRoutes from './routes/feedback.js';
import groupRoutes from './routes/groups.js';
import helpRoutes from './routes/help.js';
import instructorRoutes from './routes/instructor.js';
import leaderboardRoutes from './routes/leaderboard.js';
import logsRoutes from './routes/logs.js';
import notificationRoutes from './routes/notifications.js';
import paymentRoutes from './routes/payment.js';
import profileRoutes from './routes/profile.js';
import resourceRoutes from './routes/resources.js';
import resultRoutes from './routes/result.js';
import settingsRoutes from './routes/settings.js';
import ticketRoutes from './routes/tickets.js';

const app = express();

// Connect DB — on Vercel do not block cold start (long retry loops cause FUNCTION_INVOCATION_FAILED).
let mongoBootError = null;
const isVercel = Boolean(process.env.VERCEL);

const bootDb = async () => {
  try {
    await connectDB();
    await seedHelpTopicsIfEmpty().catch(() => {});
    if (!isVercel) scheduleProctoringScreenshotCleanup();
  } catch (e) {
    mongoBootError = e;
  }
};

if (isVercel) {
  bootDb().catch((e) => { mongoBootError = e; });
} else {
  await bootDb();
}

// If DB is down, fail fast (don't let Mongoose buffer requests indefinitely in dev)
mongoose.set('bufferCommands', false);
mongoose.set('bufferTimeoutMS', 1000);

// ── CORS — must run first; fallback middleware guarantees ACAO on Vercel/serverless ─
app.set('trust proxy', 1);
app.use(corsHeadersMiddleware);
const corsOptions = createCorsOptions();
app.use(helmet({ crossOriginEmbedderPolicy: false, contentSecurityPolicy: false }));
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(process.env.COOKIE_SECRET));
app.use(mongoSanitize());

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev', { stream: { write: (msg) => logger.http(msg.trim()) } }));
}

// If Mongo isn't connected, return a helpful error for DB-backed endpoints.
// (Without this, requests may hang or appear as proxy/network errors.)
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') return next();

  const mongoReady = mongoose.connection.readyState === 1; // 1 = connected
  if (mongoReady) return next();

  // Health endpoint should still work.
  if (req.path === '/api/health' || req.path === '/health') return next();

  // Most endpoints depend on DB (including auth); be explicit and fast.
  return res.status(503).json({
    message:
      'Something went wrong. Please try again later.',
    details:
      process.env.NODE_ENV === 'development'
        ? {
            mongoReadyState: mongoose.connection.readyState,
            bootError: mongoBootError?.message || null,
          }
        : undefined,
  });
});

// Maintenance mode check (excluding admin/auth/health)
app.use(async (req, res, next) => {
  const p = req.path;
  const bypass = p.startsWith('/api/auth') || p.startsWith('/api/admin') || p === '/api/health' || p.startsWith('/api/settings/public')
    || p.startsWith('/auth') || p.startsWith('/admin') || p === '/health' || p.startsWith('/settings/public');
  if (bypass) return next();
  try {
    const settings = await getSettings();
    if (settings.maintenanceMode) {
      return res.status(503).json({ maintenance: true, message: settings.maintenanceMessage });
    }
  } catch {}
  next();
});

// Mount routes under /api/* (standard) AND /* (fallback for clients missing /api prefix)
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
app.use('/api/feedback', feedbackRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api/announcements', announcementRoutes);
app.use('/api/groups',        groupRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/resources',    resourceRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/help', helpRoutes);
app.use('/api/enterprise', enterpriseRoutes);

// Bare-path fallback (handles VITE_API_URL set without /api suffix)
app.use(apiLimiter);
app.use('/auth', authRoutes);
app.use('/exams', examRoutes);
app.use('/results', resultRoutes);
app.use('/certificates', certificateRoutes);
app.use('/leaderboard', leaderboardRoutes);
app.use('/profile', profileRoutes);
app.use('/admin', adminRoutes);
app.use('/settings', settingsRoutes);
app.use('/logs', logsRoutes);
app.use('/payments', paymentRoutes);
app.use('/instructor', instructorRoutes);
app.use('/feedback', feedbackRoutes);
app.use('/contact', contactRoutes);
app.use('/announcements', announcementRoutes);
app.use('/groups', groupRoutes);
app.use('/tickets', ticketRoutes);
app.use('/help', helpRoutes);
app.use('/enterprise', enterpriseRoutes);

const healthPayload = () => ({
  status: mongoose.connection.readyState === 1 ? 'ok' : 'degraded',
  mongoReadyState: mongoose.connection.readyState,
  env: process.env.NODE_ENV,
  time: new Date().toISOString(),
});

app.get('/api/health', (req, res) => res.json(healthPayload()));
app.get('/health', (req, res) => res.json(healthPayload()));

// ── Serve React frontend in production ───────────────────────────────────────
const clientDist = path.join(__dirname, '../client/dist');
app.use(express.static(clientDist, { maxAge: '1d' }));

// Static asset extensions — never serve index.html for these
const STATIC_EXT = /\.(png|jpg|jpeg|gif|svg|ico|webp|avif|woff|woff2|ttf|eot|otf|css|js|mjs|map|json|txt|xml)$/i;

// SPA fallback — send index.html for any non-API, non-asset route
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth') || req.path.startsWith('/exams')
    || req.path.startsWith('/results') || req.path.startsWith('/certificates')
    || req.path.startsWith('/leaderboard') || req.path.startsWith('/profile')
    || req.path.startsWith('/admin') || req.path.startsWith('/settings')
    || req.path.startsWith('/logs') || req.path.startsWith('/payments')
    || req.path.startsWith('/instructor') || req.path.startsWith('/feedback')
    || req.path.startsWith('/contact') || req.path.startsWith('/announcements')
    || req.path.startsWith('/groups')     || req.path.startsWith('/tickets')
    || req.path.startsWith('/enterprise')
    || req.path === '/health') {
    return next();
  }
  // Let express.static handle known asset types — don't override with index.html
  if (STATIC_EXT.test(req.path)) return next();
  const indexFile = path.join(clientDist, 'index.html');
  res.sendFile(indexFile, (err) => {
    if (err) next(); // file not found — don't crash in dev
  });
});

app.use('*', (req, res) => res.status(404).json({ message: `Route ${req.originalUrl} not found` }));
app.use(errorHandler);

// Vercel serverless serves `export default app`; only listen for local / traditional hosting.
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => logger.info(`🚀 Server running on port ${PORT} [${process.env.NODE_ENV}]`));
}

export default app;
