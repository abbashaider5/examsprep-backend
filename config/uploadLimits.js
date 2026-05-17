/** Vercel serverless request body cap (~4.5 MB). Local/dev allows larger uploads. */
export const RESOURCE_UPLOAD_MAX_BYTES = process.env.VERCEL
  ? Math.floor(4.5 * 1024 * 1024)
  : 20 * 1024 * 1024;
