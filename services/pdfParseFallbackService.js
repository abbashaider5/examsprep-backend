import { createRequire } from 'module';
import { logPdfExtract } from '../utils/pdfExtractionDiagnostics.js';

const require = createRequire(import.meta.url);

/**
 * Fallback text extraction when pdfjs-dist fails (common on Vercel serverless).
 * @param {Buffer} buffer
 * @param {{ label?: string }} [meta]
 */
export async function extractPdfWithPdfParse(buffer, meta = {}) {
  const pdfParse = require('pdf-parse');
  logPdfExtract('pdf_parse_start', { label: meta.label || '', bytes: buffer?.length || 0 });

  const data = await pdfParse(buffer);
  const text = (data?.text || '').trim();
  const pages = Number(data?.numpages) || 1;

  logPdfExtract('pdf_parse_done', {
    label: meta.label || '',
    pages,
    textLen: text.length,
  });

  return { text, pages, usedOcr: false };
}
