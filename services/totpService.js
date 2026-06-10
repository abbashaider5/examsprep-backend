import crypto from 'crypto';
import QRCode from 'qrcode';
import { generateSecret, generateURI, verify } from 'otplib';

const APP_NAME = 'LikhitAI';
const ALGO = 'aes-256-gcm';

function encryptionKey() {
  const raw = process.env.TOTP_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!raw) throw new Error('JWT_SECRET is required for TOTP encryption');
  return crypto.createHash('sha256').update(raw).digest();
}

export function encryptTotpSecret(plain) {
  const key = encryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decryptTotpSecret(payload) {
  if (!payload) return '';
  const [ivB64, tagB64, dataB64] = String(payload).split(':');
  if (!ivB64 || !tagB64 || !dataB64) return '';
  const key = encryptionKey();
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
  return dec.toString('utf8');
}

export function createTotpSecret() {
  return generateSecret();
}

export async function buildTotpQrDataUrl(email, secret) {
  const uri = generateURI({
    issuer: APP_NAME,
    label: email,
    secret,
  });
  return QRCode.toDataURL(uri);
}

export async function verifyTotpToken(secret, token) {
  const code = String(token || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return false;
  const result = await verify({
    secret,
    token: code,
    epochTolerance: 1,
  });
  return Boolean(result?.valid);
}
