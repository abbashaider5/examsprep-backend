const REQUIRED_CORE = ['MONGODB_URI', 'JWT_SECRET', 'JWT_REFRESH_SECRET'];
const REQUIRED_AI = ['GROQ_API_KEY'];

export const validateEnv = () => {
  const missingCore = REQUIRED_CORE.filter((k) => !process.env[k]);
  if (missingCore.length > 0) {
    const msg = `[ENV] Missing required environment variables: ${missingCore.join(', ')}`;
    if (process.env.VERCEL) {
      console.error(msg);
    } else {
      console.error(msg);
      console.error('[ENV] Copy .env.example to .env and fill in the values.');
      process.exit(1);
    }
  }

  const missingAi = REQUIRED_AI.filter((k) => !process.env[k]);
  if (missingAi.length > 0) {
    console.warn(`[ENV] Missing AI keys (${missingAi.join(', ')}) — exam generation will fail until set.`);
  }

  if (!process.env.RESEND_API_KEY?.trim()) {
    console.warn('[ENV] RESEND_API_KEY is not set — transactional email (OTP, invites, welcome) is disabled.');
  }
};
