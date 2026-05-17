import mongoose from 'mongoose';

const connectOptions = () => ({
  serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 20000),
  connectTimeoutMS: Number(process.env.MONGO_CONNECT_TIMEOUT_MS || 20000),
  socketTimeoutMS: Number(process.env.MONGO_SOCKET_TIMEOUT_MS || 45000),
  maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE || 10),
  minPoolSize: Number(process.env.MONGO_MIN_POOL_SIZE || 0),
});

/** Reuse one connection across Vercel serverless invocations (warm instances). */
function getConnectionCache() {
  const g = globalThis;
  if (!g.__likhitaiMongoose) {
    g.__likhitaiMongoose = { promise: null };
  }
  return g.__likhitaiMongoose;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tryConnect(uri, label) {
  const conn = await mongoose.connect(uri, connectOptions());
  // eslint-disable-next-line no-console
  console.log(`MongoDB connected (${label}): ${conn.connection.host}`);
  return conn;
}

async function connectWithRetry(uri, label) {
  const defaultAttempts = process.env.VERCEL ? 2 : 5;
  const maxAttempts = Number(process.env.MONGO_CONNECT_MAX_ATTEMPTS || defaultAttempts);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await tryConnect(uri, label);
    } catch (err) {
      const msg = err?.message || String(err);
      // eslint-disable-next-line no-console
      console.error(`MongoDB connection error (${label}) [attempt ${attempt}/${maxAttempts}]:`, msg);
      if (attempt === maxAttempts) throw err;
      const backoffMs = Math.min(15000, 500 * 2 ** (attempt - 1));
      await sleep(backoffMs);
    }
  }
  return null;
}

export const connectDB = async () => {
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  const cache = getConnectionCache();
  if (cache.promise) {
    try {
      return await cache.promise;
    } catch (e) {
      cache.promise = null;
      throw e;
    }
  }

  const primaryUri = process.env.MONGODB_URI;
  const fallbackUri =
    process.env.MONGODB_URI_FALLBACK || 'mongodb://127.0.0.1:27017/examprep';

  cache.promise = (async () => {
    try {
      if (!primaryUri) throw new Error('MONGODB_URI is not set');
      const conn = await connectWithRetry(primaryUri, 'primary');

      mongoose.connection.on('disconnected', () => {
        // eslint-disable-next-line no-console
        console.error('MongoDB disconnected.');
        cache.promise = null;
      });

      return conn;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('MongoDB connection error (primary):', err?.message || err);

      if (process.env.NODE_ENV === 'development' && !process.env.VERCEL) {
        try {
          // eslint-disable-next-line no-console
          console.log(`Attempting MongoDB fallback (${fallbackUri})...`);
          return await connectWithRetry(fallbackUri, 'fallback');
        } catch (fallbackErr) {
          // eslint-disable-next-line no-console
          console.error('MongoDB connection error (fallback):', fallbackErr?.message || fallbackErr);
        }
      }
      throw err;
    }
  })();

  try {
    return await cache.promise;
  } catch (e) {
    cache.promise = null;
    return null;
  }
};

/** Clear a stale in-flight connect so the next attempt can open a fresh socket. */
export function resetDbConnectionCache() {
  const cache = getConnectionCache();
  cache.promise = null;
}

/** Await a live Mongo connection before handling DB-backed routes (serverless-safe). */
export async function ensureDbConnected() {
  if (mongoose.connection.readyState === 1) return true;

  const cache = getConnectionCache();
  const maxAttempts = Number(process.env.MONGO_ENSURE_MAX_ATTEMPTS || (process.env.VERCEL ? 5 : 3));
  const baseDelayMs = Number(process.env.MONGO_ENSURE_RETRY_MS || 400);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (mongoose.connection.readyState === 1) return true;

    if (mongoose.connection.readyState === 2 && cache.promise) {
      try {
        await cache.promise;
      } catch {
        resetDbConnectionCache();
      }
      if (mongoose.connection.readyState === 1) return true;
    }

    if (mongoose.connection.readyState === 0 || mongoose.connection.readyState === 3) {
      resetDbConnectionCache();
    }

    try {
      const conn = await connectDB();
      if (conn && mongoose.connection.readyState === 1) return true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`ensureDbConnected attempt ${attempt}/${maxAttempts}:`, err?.message || err);
      resetDbConnectionCache();
    }

    if (attempt < maxAttempts) {
      await sleep(Math.min(8000, baseDelayMs * attempt));
    }
  }

  return mongoose.connection.readyState === 1;
}
