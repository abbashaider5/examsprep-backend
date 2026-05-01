import mongoose from 'mongoose';

export const connectDB = async () => {
  const primaryUri = process.env.MONGODB_URI;
  const fallbackUri =
    process.env.MONGODB_URI_FALLBACK || 'mongodb://127.0.0.1:27017/examprep';

  const tryConnect = async (uri, label) => {
    const conn = await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    // eslint-disable-next-line no-console
    console.log(`MongoDB connected (${label}): ${conn.connection.host}`);
    return conn;
  };

  try {
    if (!primaryUri) throw new Error('MONGODB_URI is not set');
    return await tryConnect(primaryUri, 'primary');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('MongoDB connection error (primary):', err?.message || err);

    // In dev, fall back to local Mongo instead of crashing the whole API server.
    if (process.env.NODE_ENV === 'development') {
      try {
        // eslint-disable-next-line no-console
        console.log(`Attempting MongoDB fallback (${fallbackUri})...`);
        return await tryConnect(fallbackUri, 'fallback');
      } catch (fallbackErr) {
        // eslint-disable-next-line no-console
        console.error('MongoDB connection error (fallback):', fallbackErr?.message || fallbackErr);
      }
    }

    // Do not exit here; keep server running so health/auth endpoints can return a useful error.
    return null;
  }
};
