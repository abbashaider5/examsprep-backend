import mongoose from 'mongoose';

export const connectDB = async () => {
  const primaryUri = process.env.MONGODB_URI;
  const fallbackUri =
    process.env.MONGODB_URI_FALLBACK || 'mongodb://127.0.0.1:27017/examprep';

  const connectOptions = {
    // Atlas / SRV DNS + cold start can be slow; 5s causes intermittent failures.
    serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 20000),
    connectTimeoutMS: Number(process.env.MONGO_CONNECT_TIMEOUT_MS || 20000),
    socketTimeoutMS: Number(process.env.MONGO_SOCKET_TIMEOUT_MS || 45000),
    maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE || 10),
    minPoolSize: Number(process.env.MONGO_MIN_POOL_SIZE || 0),
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const tryConnect = async (uri, label) => {
    const conn = await mongoose.connect(uri, connectOptions);
    // eslint-disable-next-line no-console
    console.log(`MongoDB connected (${label}): ${conn.connection.host}`);
    return conn;
  };

  const connectWithRetry = async (uri, label) => {
    const defaultAttempts = process.env.VERCEL ? 2 : 5;
    const maxAttempts = Number(process.env.MONGO_CONNECT_MAX_ATTEMPTS || defaultAttempts);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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
  };

  try {
    if (!primaryUri) throw new Error('MONGODB_URI is not set');
    const conn = await connectWithRetry(primaryUri, 'primary');

    // If Mongo drops later, attempt to reconnect without killing the server.
    mongoose.connection.on('disconnected', async () => {
      // eslint-disable-next-line no-console
      console.error('MongoDB disconnected. Attempting reconnect...');
      try {
        await connectWithRetry(primaryUri, 'primary-reconnect');
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('MongoDB reconnect failed:', e?.message || e);
      }
    });

    return conn;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('MongoDB connection error (primary):', err?.message || err);

    // In dev, fall back to local Mongo instead of crashing the whole API server.
    if (process.env.NODE_ENV === 'development') {
      try {
        // eslint-disable-next-line no-console
        console.log(`Attempting MongoDB fallback (${fallbackUri})...`);
        return await connectWithRetry(fallbackUri, 'fallback');
      } catch (fallbackErr) {
        // eslint-disable-next-line no-console
        console.error('MongoDB connection error (fallback):', fallbackErr?.message || fallbackErr);
      }
    }

    // Do not exit here; keep server running so health/auth endpoints can return a useful error.
    return null;
  }
};
