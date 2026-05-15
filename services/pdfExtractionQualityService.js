import { isWeakPdfTextExtract } from './pdfHybridExtractionService.js';

/**
 * Decide whether to run paid/heavy PDF→DOCX recovery while avoiding needless conversions.
 * Called after hybrid PDF extraction + the same cleaning path used for indexing.
 *
 * @param {{ cleanedText: string, pages: number, usedOcr: boolean }} p
 * @returns {{ needed: boolean, reason: string }}
 */
export function assessPdfNeedsDocxConversion({ cleanedText, pages, usedOcr }) {
  const t = (cleanedText || '').trim();
  const p = Math.max(1, pages || 1);

  if (t.length < 80) {
    return { needed: true, reason: 'below_minimum' };
  }

  if (isWeakPdfTextExtract(t, p)) {
    return { needed: true, reason: 'weak_heuristic' };
  }

  const letters = (t.match(/\p{L}/gu) || []).length;
  const letterRatio = t.length ? letters / t.length : 0;
  if (t.length < 900 && letterRatio < 0.16) {
    return { needed: true, reason: 'low_letter_density' };
  }

  const fffd = (t.match(/\uFFFD/g) || []).length;
  if (fffd >= 4 && fffd > t.length * 0.002) {
    return { needed: true, reason: 'replacement_chars' };
  }

  const ctrl = (t.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) || []).length;
  if (ctrl > 20 && ctrl > t.length * 0.01) {
    return { needed: true, reason: 'control_char_noise' };
  }

  if (usedOcr && p >= 4 && t.length / p < 48) {
    return { needed: true, reason: 'ocr_sparse_multipage' };
  }

  return { needed: false, reason: '' };
}
