import logger from './logger.js';

/**
 * Production-safe PDF extraction diagnostics (no file contents logged).
 * @param {string} stage
 * @param {Record<string, unknown>} [fields]
 */
export function logPdfExtract(stage, fields = {}) {
  const payload = {
    stage,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    vercel: Boolean(process.env.VERCEL),
    vercelEnv: process.env.VERCEL_ENV || '',
    region: process.env.VERCEL_REGION || '',
    ...fields,
  };
  logger.info(`[pdfExtract] ${stage}`, payload);
}

/**
 * @param {Buffer} buffer
 */
export function pdfBufferFingerprint(buffer) {
  if (!buffer?.length) {
    return { bytes: 0, header: '', hasPdfSig: false };
  }
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const header = b.slice(0, Math.min(8, b.length)).toString('ascii').replace(/[^\x20-\x7E]/g, '.');
  const hasPdfSig = b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;
  return { bytes: b.length, header, hasPdfSig };
}

/**
 * Map pdf.js / IO errors to stable internal codes + user-facing messages.
 * @param {Error} err
 */
export function classifyPdfExtractError(err) {
  const msg = String(err?.message || err || '');
  const lower = msg.toLowerCase();

  if (/password|encrypted|decrypt|needs password/i.test(lower)) {
    return {
      code: 'PDF_ENCRYPTED',
      userMessage: 'This PDF is password-protected. Remove the password and export again, or upload a Word (.docx) file.',
      internalReason: 'encrypted_pdf',
    };
  }
  if (/invalid pdf|invalid header|corrupt|xref|malformed|not a pdf|missing pdf header/i.test(lower)) {
    return {
      code: 'PDF_MALFORMED',
      userMessage: 'This PDF file looks corrupted or incomplete. Try exporting it again from the original app.',
      internalReason: 'malformed_pdf',
    };
  }
  if (/too small|empty buffer|no pdf/i.test(lower)) {
    return {
      code: 'PDF_MALFORMED',
      userMessage: 'The uploaded file appears empty or truncated. Please upload again.',
      internalReason: 'empty_or_truncated',
    };
  }
  if (/worker|structured clone|eval|dynamic import|cannot find module.*pdfjs/i.test(lower)) {
    return {
      code: 'PDF_RUNTIME',
      userMessage: 'PDF processing failed on the server. Please retry in a moment or upload a Word (.docx) file.',
      internalReason: 'pdfjs_runtime',
    };
  }
  if (/timeout|timed out|etimedout/i.test(lower)) {
    return {
      code: 'PDF_RUNTIME',
      userMessage: 'Reading this PDF took too long. Try a smaller file or upload Word (.docx).',
      internalReason: 'timeout',
    };
  }

  return {
    code: 'EXTRACTION_FAILED',
    userMessage: 'This PDF could not be opened. It may be corrupted, password-protected, or an unusual export.',
    internalReason: 'pdfjs_open_failed',
  };
}
