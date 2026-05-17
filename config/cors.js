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
    /* ignore */
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

/** Vercel injects deployment URLs at runtime — always allow these. */
function vercelDeploymentOrigins() {
  const out = [];
  for (const key of ['VERCEL_URL', 'VERCEL_BRANCH_URL', 'VERCEL_PROJECT_PRODUCTION_URL']) {
    const v = process.env[key];
    if (!v) continue;
    const withProto = v.startsWith('http') ? v : `https://${v}`;
    for (const variant of wwwVariants(withProto)) out.push(variant);
  }
  return out;
}

export function buildAllowedOriginSet() {
  const set = new Set(PRODUCTION_ORIGINS.map(normalizeOrigin));

  for (const url of [
    process.env.CLIENT_URL,
    process.env.FRONTEND_URL,
    process.env.VITE_SITE_URL,
    process.env.EMAIL_PUBLIC_URL,
  ]) {
    for (const v of wwwVariants(url)) set.add(v);
  }

  for (const o of [...parseExtraOrigins(), ...vercelDeploymentOrigins()]) {
    set.add(o);
    for (const v of wwwVariants(o)) set.add(v);
  }

  return set;
}

const LIKHITAI_HOST = /^([\w-]+\.)*likhitai\.com$/i;
const ABBAS_HOST = /^([\w-]+\.)*abbaslogic\.com$/i;
const VERCEL_HOST = /^[\w.-]+\.vercel\.app$/i;

function hostMatchesTrustedPattern(hostname) {
  if (!hostname) return false;
  return LIKHITAI_HOST.test(hostname) || ABBAS_HOST.test(hostname) || VERCEL_HOST.test(hostname);
}

export function isOriginAllowed(origin, allowedSet) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return true;
  if (allowedSet.has(normalized)) return true;

  try {
    const { hostname, protocol } = new URL(normalized);
    if (protocol !== 'https:' && protocol !== 'http:') return false;
    if (hostMatchesTrustedPattern(hostname)) return true;

    const clientUrl = process.env.CLIENT_URL || process.env.FRONTEND_URL;
    if (clientUrl) {
      const clientHost = new URL(clientUrl.startsWith('http') ? clientUrl : `https://${clientUrl}`).hostname;
      if (hostname === clientHost) return true;
    }
  } catch {
    return false;
  }

  return false;
}

export function createCorsOptions() {
  return {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      const allowedSet = buildAllowedOriginSet();
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
    preflightContinue: false,
  };
}

/** Safety net: ensure ACAO is set on every response when origin is trusted. */
export function corsHeadersMiddleware(req, res, next) {
  const origin = req.headers.origin;
  if (!origin) return next();

  const allowedSet = buildAllowedOriginSet();
  if (!isOriginAllowed(origin, allowedSet)) return next();

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept');
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.status(204).end();
  }

  next();
}
