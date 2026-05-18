import '../utils/runtimePolyfills.js';
import { extractText, getDocumentProxy } from 'unpdf';
import { logPdfExtract } from '../utils/pdfExtractionDiagnostics.js';

/**
 * PDF text extraction via unpdf (serverless PDF.js build — reliable on Vercel).
 * @param {Buffer} buffer
 * @param {{ label?: string }} [meta]
 */
export async function extractPdfWithUnpdf(buffer, meta = {}) {
  logPdfExtract('unpdf_start', { label: meta.label || '', bytes: buffer?.length || 0 });

  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { totalPages, text } = await extractText(pdf, { mergePages: true });

  const merged = typeof text === 'string'
    ? text
    : (Array.isArray(text) ? text.join('\n\n') : '');

  logPdfExtract('unpdf_done', {
    label: meta.label || '',
    pages: totalPages || 1,
    textLen: merged.trim().length,
  });

  return {
    text: merged.trim(),
    pages: totalPages || 1,
    usedOcr: false,
  };
}
