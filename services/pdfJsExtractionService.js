/**
 * Direct pdf.js (pdfjs-dist) text extraction for educational PDFs.
 * Page-by-page getPage → getTextContent, merged in reading order.
 */
import { createRequire } from 'module';
import path from 'path';
import { pathToFileURL } from 'node:url';
import logger from '../utils/logger.js';

const require = createRequire(import.meta.url);
const pdfjsPath = path.dirname(require.resolve('pdfjs-dist/package.json'));

const PDF_SIG = [0x25, 0x50, 0x44, 0x46]; // %PDF

/** pdf.js requires factory URLs to end with `/` (forward slash); plain Windows paths fail. */
function pdfJsDirUrl(absoluteDir) {
  const resolved = path.resolve(absoluteDir);
  const withSep = resolved.endsWith(path.sep) ? resolved : resolved + path.sep;
  let href = pathToFileURL(withSep).href;
  if (!href.endsWith('/')) href = `${href}/`;
  return href;
}

/**
 * Strip BOM / find %PDF offset so parsers see a real file (CDN quirks, prepended bytes).
 * @param {Buffer} buffer
 * @returns {Buffer}
 */
export function normalizePdfBuffer(buffer) {
  if (!buffer || buffer.length < 5) return buffer;
  let u8 = Buffer.isBuffer(buffer) ? Uint8Array.from(buffer) : new Uint8Array(buffer);
  let start = 0;
  if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) start = 3;
  if (start) u8 = u8.subarray(start);
  if (
    u8.length >= 4
    && u8[0] === PDF_SIG[0]
    && u8[1] === PDF_SIG[1]
    && u8[2] === PDF_SIG[2]
    && u8[3] === PDF_SIG[3]
  ) {
    return Buffer.from(u8);
  }
  const lim = Math.min(u8.length - 4, 32768);
  for (let i = 0; i <= lim; i++) {
    if (
      u8[i] === PDF_SIG[0]
      && u8[i + 1] === PDF_SIG[1]
      && u8[i + 2] === PDF_SIG[2]
      && u8[i + 3] === PDF_SIG[3]
    ) {
      return Buffer.from(u8.subarray(i));
    }
  }
  return Buffer.from(u8);
}

/**
 * Build page text from pdf.js text items (respects hasEOL like browser extraction).
 * @param {import('pdfjs-dist').TextContent} textContent
 */
export function pageTextFromTextContent(textContent) {
  const items = textContent?.items || [];
  if (!items.length) return '';

  const parts = [];
  for (const item of items) {
    if (!item || typeof item.str !== 'string' || !item.str) continue;
    parts.push(item.str);
    if (item.hasEOL) parts.push('\n');
  }

  return parts
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[^\S\n]+/g, ' ')
    .trim();
}

/**
 * @param {import('pdfjs-dist').PDFDocumentProxy} pdfDocument
 * @param {{ onPage?: (pageNum: number, total: number) => void }} [opts]
 */
async function readTextFromPdfDocument(pdfDocument, opts = {}) {
  const numPages = pdfDocument.numPages || 0;
  const pageTexts = [];

  for (let p = 1; p <= numPages; p++) {
    opts.onPage?.(p, numPages);
    const page = await pdfDocument.getPage(p);
    const textContent = await page.getTextContent();
    const pageText = pageTextFromTextContent(textContent);
    if (pageText) pageTexts.push(pageText);
    page.cleanup?.();
  }

  return { text: pageTexts.join('\n\n').trim(), pages: numPages };
}

/**
 * Heuristic: likely scanned / image PDF or broken extract when text is sparse vs page count.
 */
export function isWeakPdfTextExtract(text, pageCount) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  const pages = Math.max(1, pageCount || 1);
  const letters = (t.match(/\p{L}/gu) || []).length;

  if (pages === 1 && t.length >= 28 && letters >= 18 && letters / t.length >= 0.35) {
    const weird = (t.match(/\uFFFD/g) || []).length;
    if (weird <= 2) return false;
  }

  if (t.length < 80) return true;
  if (pages >= 2 && t.length / pages < 34) return true;
  if (t.length > 240 && letters / t.length < 0.12) return true;
  const weird = (t.match(/\uFFFD/g) || []).length;
  if (weird > 8 && weird > t.length * 0.02) return true;
  return false;
}

/**
 * Open PDF with pdfjs-dist (tries legacy + modern builds and font/cmap variants).
 * @param {Buffer} buffer normalized PDF bytes
 * @param {{ onPage?: (pageNum: number, total: number) => void }} [opts]
 */
async function extractTextViaPdfJs(buffer, opts = {}) {
  const data = Uint8Array.from(buffer);
  if (data.length < 20) throw new Error('PDF data too small');

  const cMapUrl = pdfJsDirUrl(path.join(pdfjsPath, 'cmaps'));
  /** @type {Record<string, unknown>[]} */
  const docInitVariants = [
    { isEvalSupported: false, disableFontFace: true, useSystemFonts: true },
    { isEvalSupported: false, disableFontFace: true, useSystemFonts: true, cMapUrl, cMapPacked: true },
    {
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: true,
      standardFontDataUrl: pdfJsDirUrl(path.join(pdfjsPath, 'standard_fonts')),
      cMapUrl,
      cMapPacked: true,
    },
  ];

  const loaders = [
    () => import('pdfjs-dist/legacy/build/pdf.mjs'),
    () => import('pdfjs-dist/build/pdf.mjs'),
  ];

  let lastErr = new Error('pdf.js could not open this document');
  for (const load of loaders) {
    let pdfjs;
    try {
      pdfjs = await load();
    } catch (e) {
      lastErr = e;
      continue;
    }
    if (typeof pdfjs.getDocument !== 'function') continue;

    for (const extra of docInitVariants) {
      let pdfDocument;
      try {
        const task = pdfjs.getDocument({ data, ...extra });
        pdfDocument = await task.promise;
      } catch (e) {
        lastErr = e;
        logger.debug(`[pdfJs] getDocument failed (${e.message})`);
        continue;
      }
      try {
        return await readTextFromPdfDocument(pdfDocument, opts);
      } catch (e) {
        lastErr = e;
        logger.debug(`[pdfJs] getTextContent failed (${e.message})`);
      } finally {
        await pdfDocument.cleanup?.().catch(() => {});
      }
    }
  }
  throw lastErr;
}

const SCANNED_USER_MESSAGE =
  'This PDF appears to be scanned or image-based. For best results, upload a Word (.docx) file or a text-based PDF exported from your original document.';

/**
 * Extract text using pdfjs-dist only (no pdf-parse, no OCR).
 * @param {Buffer} buffer
 * @param {{ onStage?: (msg: string) => void }} [opts]
 * @returns {Promise<{ text: string, pages: number, usedOcr: false }>}
 */
export async function extractPdfWithPdfJs(buffer, opts = {}) {
  const { onStage } = opts;
  onStage?.('Reading PDF content…');

  const normalized = normalizePdfBuffer(buffer);
  let result;

  try {
    result = await extractTextViaPdfJs(normalized, {
      onPage: (p, total) => {
        if (total > 1) onStage?.(`Reading PDF content… page ${p} of ${total}`);
      },
    });
  } catch (e) {
    logger.warn(`[pdfJs] extraction failed: ${e.message}`);
    const err = new Error('This PDF could not be opened. It may be corrupted, password-protected, or an unusual export.');
    err.code = 'EXTRACTION_FAILED';
    throw err;
  }

  const text = (result.text || '').trim();
  const pages = result.pages || 0;

  if (isWeakPdfTextExtract(text, pages)) {
    const err = new Error(SCANNED_USER_MESSAGE);
    err.code = 'PDF_SCANNED';
    throw err;
  }

  onStage?.('Processing educational document…');

  return { text, pages: pages || 1, usedOcr: false };
}

/** @deprecated use extractPdfWithPdfJs */
export const extractPdfHybrid = extractPdfWithPdfJs;
