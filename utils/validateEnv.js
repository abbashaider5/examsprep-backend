const REQUIRED_VARS = [
  'MONGODB_URI',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'GROQ_API_KEY',
];

export const validateEnv = () => {
  const missing = REQUIRED_VARS.filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.error(`[ENV] Missing required environment variables: ${missing.join(', ')}`);
    console.error('[ENV] Copy .env.example to .env and fill in the values.');
    process.exit(1);
  }
  if (!process.env.RESEND_API_KEY?.trim()) {
    console.warn('[ENV] RESEND_API_KEY is not set — transactional email (OTP, invites, welcome, admin provision) is disabled.');
  }
};
