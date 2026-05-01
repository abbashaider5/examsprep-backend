/**
 * Cache Service — Redis (when REDIS_URL is set) with automatic in-memory fallback.
 *
 * Usage:
 *   import { getCache, setCache, delCache, delPattern } from './cacheService.js';
 *
 * Env:
 *   REDIS_URL  (optional) — e.g. rediss://default:<token>@<host>:6380  (Upstash)
 *                           or    redis://localhost:6379
 *   When not set, an in-memory store handles all caching (resets on restart).
 */

import logger from '../utils/logger.js';

// ── In-memory fallback ─────────────────────────────────────────────────────────
class MemoryStore {
  #store = new Map();

  constructor() {
    // Prune expired keys every minute
    setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.#store) {
        if (now > v.exp) this.#store.delete(k);
      }
    }, 60_000).unref();
  }

  get(key) {
    const item = this.#store.get(key);
    if (!item) return null;
    if (Date.now() > item.exp) { this.#store.delete(key); return null; }
    return item.value;
  }

  set(key, value, ttl) {
    this.#store.set(key, { value, exp: Date.now() + ttl * 1000 });
  }

  del(...keys) {
    for (const k of keys) this.#store.delete(k);
  }

  delPattern(pattern) {
    // Convert glob pattern (* → .*) to regex
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const re = new RegExp(`^${escaped}$`);
    for (const k of this.#store.keys()) {
      if (re.test(k)) this.#store.delete(k);
    }
  }
}

const mem = new MemoryStore();

// ── Redis setup (optional) ─────────────────────────────────────────────────────
let redis = null;

if (process.env.REDIS_URL) {
  try {
    const { default: Redis } = await import('ioredis');
    redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue:   false,
      connectTimeout:       4000,
      tls:                  process.env.REDIS_URL.startsWith('rediss://') ? {} : undefined,
      retryStrategy:        (times) => (times <= 3 ? Math.min(times * 500, 2000) : null),
    });
    redis.on('connect', () => logger.info('[Cache] Redis connected'));
    redis.on('error',   (err) => {
      logger.warn('[Cache] Redis error — using in-memory fallback: ' + err.message);
    });
  } catch (err) {
    logger.warn('[Cache] Redis init failed — using in-memory fallback: ' + err.message);
    redis = null;
  }
} else {
  logger.info('[Cache] REDIS_URL not set — using in-memory cache (add REDIS_URL for Redis)');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const isUp = () => redis && redis.status === 'ready';

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Get a cached value. Returns null on miss or error.
 */
export const getCache = async (key) => {
  if (isUp()) {
    try {
      const val = await redis.get(key);
      return val ? JSON.parse(val) : null;
    } catch {
      return mem.get(key);
    }
  }
  return mem.get(key);
};

/**
 * Set a value with TTL in seconds (default: 5 minutes).
 */
export const setCache = async (key, value, ttl = 300) => {
  if (isUp()) {
    try {
      await redis.setex(key, ttl, JSON.stringify(value));
      return;
    } catch { /* fall through to memory */ }
  }
  mem.set(key, value, ttl);
};

/**
 * Delete one or more keys.
 */
export const delCache = async (...keys) => {
  if (keys.length === 0) return;
  if (isUp()) {
    try { await redis.del(...keys); return; } catch { /* fall through */ }
  }
  mem.del(...keys);
};

/**
 * Delete all keys matching a glob pattern (e.g. "analytics:*").
 */
export const delPattern = async (pattern) => {
  if (isUp()) {
    try {
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = next;
        if (keys.length) await redis.del(...keys);
      } while (cursor !== '0');
      return;
    } catch { /* fall through */ }
  }
  mem.delPattern(pattern);
};
