import logger from '../utils/logger.js';

const PRODUCTION_ORIGINS = [
  'https://likhitai.com',
  'https://www.likhitai.com',
  'https://exams.abbaslogic.com',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:4173',
];

export const normalizeOrigin = (value) => {
  if (!value) return '';
  return value.endsWith('/') ? value.slice(0, -1) : value;
};

/** Add www / non-www variant for a canonical site URL. */
function wwwVariants(origin) {
  const n = normalizeOrigin(origin);
  if (!n) return [];
  const out = new Set([n]);
  try {
    const u = new URL(n);
    const host = u.hostname;
    if (host.startsWith('www.')) {
      out.add(normalizeOrigin(`${u.protocol}//${host.slice(4)}`));
    } else if (!host.includes('localhost') && host.includes('.')) {
      out.add(normalizeOrigin(`${u.protocol}//www.${host}`));
    }
  } catch {
    /* ignore invalid URLs */
  }
  return [...out];
}

function parseExtraOrigins() {
  const raw = process.env.CORS_ORIGINS || process.env.EXTRA_CORS_ORIGINS || '';
  return raw
    .split(/[,;\s]+/)
    .map((s) => normalizeOrigin(s.trim()))
    .filter(Boolean);
}

export function buildAllowedOriginSet() {
  const set = new Set(PRODUCTION_ORIGINS.map(normalizeOrigin));

  for (const url of [process.env.CLIENT_URL, process.env.FRONTEND_URL, process.env.VITE_SITE_URL]) {
    for (const v of wwwVariants(url)) set.add(v);
  }

  for (const o of parseExtraOrigins()) {
    set.add(o);
    for (const v of wwwVariants(o)) set.add(v);
  }

  return set;
}

const LIKHITAI_SUBDOMAIN = /^https:\/\/([a-z0-9-]+\.)*likhitai\.com$/i;
const VERCEL_APP = /^https:\/\/[a-z0-9][a-z0-9-]*\.vercel\.app$/i;

export function isOriginAllowed(origin, allowedSet) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return true;
  if (allowedSet.has(normalized)) return true;
  if (LIKHITAI_SUBDOMAIN.test(normalized)) return true;
  if (VERCEL_APP.test(normalized)) return true;
  return false;
}

export function createCorsOptions() {
  const allowedSet = buildAllowedOriginSet();

  if (process.env.NODE_ENV !== 'test') {
    logger.info(`[CORS] ${allowedSet.size} static origin(s); likhitai.com + *.vercel.app patterns enabled`);
  }

  return {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (isOriginAllowed(origin, allowedSet)) {
        return callback(null, origin);
      }
      logger.warn(`[CORS] Blocked origin: ${origin}`);
      callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
    exposedHeaders: ['Set-Cookie'],
    optionsSuccessStatus: 204,
    maxAge: 86400,
  };
}
