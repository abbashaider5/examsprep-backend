import { AppError } from '../middleware/errorHandler.js';

export async function verifyRecaptchaToken(token) {
  const secret = process.env.RECAPTCHA_SECRET_KEY;
  if (!secret) {
    throw new AppError('reCAPTCHA is not configured on the server.', 503);
  }
  if (!token) {
    throw new AppError('reCAPTCHA verification is required.', 400);
  }

  const params = new URLSearchParams();
  params.set('secret', secret);
  params.set('response', token);

  let json = null;
  try {
    const resp = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    json = await resp.json();
  } catch {
    throw new AppError('Unable to verify reCAPTCHA right now.', 503);
  }

  if (!json?.success) {
    throw new AppError('reCAPTCHA verification failed. Please try again.', 401);
  }
  return true;
}

