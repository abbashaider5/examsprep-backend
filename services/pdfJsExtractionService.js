/**
 * Server-side PDF text extraction via pdfjs-dist@3.11 (legacy Node build).
 * Optimized for Vercel serverless: CJS legacy build, file:// worker + cmaps, no browser workers.
 */
import { createRequire } from 'module';
import path from 'path';
import { pathToFileURL } from 'url';
import logger from '../utils/logger.js';
import {
  classifyPdfExtractError,
  logPdfExtract,
  pdfBufferFingerprint,
} from '../utils/pdfExtractionDiagnostics.js';

const require = createRequire(import.meta.url);

const PDF_SIG = [0x25, 0x50, 0x44, 0x46]; // %PDF

/** @type {{ pdfjs: typeof import('pdfjs-dist/legacy/build/pdf.js'); pkgDir: string } | null} */
let runtime = null;

function pdfJsDirUrl(absoluteDir) {
  const resolved = path.resolve(absoluteDir);
  const withSep = resolved.endsWith(path.sep) ? resolved : `${resolved}${path.sep}`;
  let href = pathToFileURL(withSep).href;
  if (!href.endsWith('/')) href = `${href}/`;
  return href;
}

/**
 * Load pdfjs-dist legacy CJS once (stable on Node 20 / Vercel).
 */
function getPdfJsRuntime() {
  if (runtime) return runtime;

  const pkgDir = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  const workerPath = path.join(pkgDir, 'legacy/build/pdf.worker.js');
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;

  runtime = {
    pdfjs,
    pkgDir,
    cMapUrl: pdfJsDirUrl(path.join(pkgDir, 'cmaps')),
    standardFontDataUrl: pdfJsDirUrl(path.join(pkgDir, 'standard_fonts')),
  };

  logPdfExtract('runtime_init', {
    pdfjsVersion: require('pdfjs-dist/package.json').version,
    workerSrc: pdfjs.GlobalWorkerOptions.workerSrc,
    cMapUrl: runtime.cMapUrl,
  });

  return runtime;
}

/**
 * @param {Buffer} buffer
 * @returns {Buffer}
 */
export function normalizePdfBuffer(buffer) {
  if (!buffer || buffer.length < 5) return buffer;

  let u8 = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
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
 * @param {Buffer} buffer
 * @param {{ label?: string }} [meta]
 */
export function validatePdfBuffer(buffer, meta = {}) {
  const fpIn = pdfBufferFingerprint(buffer);
  if (!fpIn.bytes) {
    const err = new Error('PDF buffer is empty');
    err.code = 'PDF_MALFORMED';
    throw err;
  }

  const normalized = normalizePdfBuffer(buffer);
  const fp = pdfBufferFingerprint(normalized);

  logPdfExtract('buffer_validated', {
    label: meta.label || '',
    inputBytes: fpIn.bytes,
    normalizedBytes: fp.bytes,
    header: fp.header,
    hasPdfSig: fp.hasPdfSig,
    trimmedLeadingBytes: fpIn.bytes - fp.bytes,
  });

  if (!fp.hasPdfSig || fp.bytes < 100) {
    const err = new Error('Invalid or truncated PDF (missing %PDF header)');
    err.code = 'PDF_MALFORMED';
    throw err;
  }

  return normalized;
}

/**
 * @param {import('pdfjs-dist/types/src/display/api').TextContent} textContent
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
 * @param {import('pdfjs-dist/types/src/display/api').PDFDocumentProxy} pdfDocument
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
 * @param {Buffer} buffer normalized PDF
 * @param {{ onPage?: (pageNum: number, total: number) => void, variant?: string }} [opts]
 */
async function extractTextViaPdfJs(buffer, opts = {}) {
  const { pdfjs, cMapUrl, standardFontDataUrl } = getPdfJsRuntime();
  const data = new Uint8Array(buffer);

  const base = {
    data,
    verbosity: 0,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: true,
  };

  /** @type {Record<string, unknown>[]} */
  const docInitVariants = [
    { ...base, label: 'minimal' },
    { ...base, cMapUrl, cMapPacked: true, label: 'cmaps' },
    {
      ...base,
      cMapUrl,
      cMapPacked: true,
      standardFontDataUrl,
      label: 'cmaps+fonts',
    },
  ];

  let lastErr = new Error('pdf.js could not open this document');

  for (const variant of docInitVariants) {
    const { label, ...docInit } = variant;
    let pdfDocument;
    try {
      logPdfExtract('getDocument_start', { variant: label || opts.variant || 'default', bytes: buffer.length });
      const task = pdfjs.getDocument(docInit);
      pdfDocument = await task.promise;
      logPdfExtract('getDocument_ok', { variant: label, numPages: pdfDocument.numPages });
    } catch (e) {
      lastErr = e;
      logger.warn(`[pdfExtract] getDocument failed (${label}): ${e?.message || e}`);
      continue;
    }

    try {
      const result = await readTextFromPdfDocument(pdfDocument, opts);
      logPdfExtract('read_pages_ok', { variant: label, pages: result.pages, textLen: result.text.length });
      return result;
    } catch (e) {
      lastErr = e;
      logger.warn(`[pdfExtract] getTextContent failed (${label}): ${e?.message || e}`);
    } finally {
      await pdfDocument.cleanup?.().catch(() => {});
    }
  }

  throw lastErr;
}

const SCANNED_USER_MESSAGE =
  'This PDF appears to be scanned or image-based. For best results, upload a Word (.docx) file or a text-based PDF exported from your original document.';

/**
 * @param {Buffer} buffer
 * @param {{ onStage?: (msg: string) => void, label?: string }} [opts]
 */
export async function extractPdfWithPdfJs(buffer, opts = {}) {
  const { onStage, label } = opts;

  logPdfExtract('extract_start', { label: label || '' });
  onStage?.('Extracting PDF text…');

  let normalized;
  try {
    normalized = validatePdfBuffer(buffer, { label });
  } catch (e) {
    const classified = classifyPdfExtractError(e);
    const err = new Error(classified.userMessage);
    err.code = classified.code;
    err.internalReason = classified.internalReason;
    throw err;
  }

  let result;
  try {
    result = await extractTextViaPdfJs(normalized, {
      onPage: (p, total) => {
        if (total > 1) onStage?.(`Extracting PDF text… page ${p} of ${total}`);
      },
    });
  } catch (e) {
    const classified = classifyPdfExtractError(e);
    logPdfExtract('extract_failed', {
      label: label || '',
      internalReason: classified.internalReason,
      error: e?.message || String(e),
    });
    const err = new Error(classified.userMessage);
    err.code = classified.code;
    err.internalReason = classified.internalReason;
    throw err;
  }

  const text = (result.text || '').trim();
  const pages = result.pages || 0;

  logPdfExtract('extract_done', { label: label || '', pages, textLen: text.length });

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
