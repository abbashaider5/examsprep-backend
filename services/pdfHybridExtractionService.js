/**
 * Hybrid PDF extraction: pdf-parse first, then OCR (pdf2pic when GraphicsMagick is available,
 * else pdf-to-img / pdf.js) + tesseract.js. Self-hosted, no paid APIs.
 *
 * pdf-parse often throws or under-extracts on otherwise valid PDFs; we fall back to the same
 * pdf.js engine used by pdf-to-img for text layers.
 */
import { createRequire } from 'module';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'node:url';
import logger from '../utils/logger.js';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');
const { createWorker } = require('tesseract.js');

const pdfjsPath = path.dirname(require.resolve('pdfjs-dist/package.json'));

/** pdf.js requires factory URLs to end with `/` (forward slash); plain Windows paths fail. */
function pdfJsDirUrl(absoluteDir) {
  const resolved = path.resolve(absoluteDir);
  const withSep = resolved.endsWith(path.sep) ? resolved : resolved + path.sep;
  let href = pathToFileURL(withSep).href;
  if (!href.endsWith('/')) href = `${href}/`;
  return href;
}

const PDF_SIG = [0x25, 0x50, 0x44, 0x46]; // %PDF

/**
 * Strip BOM / find %PDF offset so parsers see a real file (CDN quirks, prepended bytes).
 * @param {Buffer} buffer
 * @returns {Buffer}
 */
function normalizePdfBuffer(buffer) {
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

async function readTextFromPdfDocument(pdfDocument) {
  const numPages = pdfDocument.numPages || 0;
  const parts = [];
  for (let p = 1; p <= numPages; p++) {
    const page = await pdfDocument.getPage(p);
    const textContent = await page.getTextContent();
    const line = textContent.items
      .map((item) => (item && typeof item.str === 'string' ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (line) parts.push(line);
  }
  return { text: parts.join('\n\n').trim(), pages: numPages };
}

/**
 * Extract plain text via pdf.js with several open strategies (CDN/binary quirks differ by file).
 * @param {Buffer} buffer normalized PDF bytes
 * @returns {Promise<{ text: string, pages: number }>}
 */
async function extractTextViaPdfJs(buffer) {
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
        logger.debug(`[pdfHybrid] pdf.js getDocument failed (${e.message})`);
        continue;
      }
      try {
        return await readTextFromPdfDocument(pdfDocument);
      } catch (e) {
        lastErr = e;
        logger.debug(`[pdfHybrid] pdf.js getTextContent failed (${e.message})`);
      } finally {
        await pdfDocument.cleanup?.().catch(() => {});
      }
    }
  }
  throw lastErr;
}

const MAX_OCR_PAGES = Math.min(60, Math.max(5, Number(process.env.PDF_OCR_MAX_PAGES) || 18));
const MAX_OCR_BYTES = Number(process.env.PDF_OCR_MAX_BYTES) || 22 * 1024 * 1024;
const OCR_TOTAL_MS = Number(process.env.PDF_OCR_TOTAL_TIMEOUT_MS) || 120_000;
const OCR_PAGE_MS = Number(process.env.PDF_OCR_PAGE_TIMEOUT_MS) || 55_000;

/**
 * Heuristic: likely scanned / image PDF or broken extract when text is sparse vs page count.
 */
export function isWeakPdfTextExtract(text, pageCount) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  const pages = Math.max(1, pageCount || 1);
  const letters = (t.match(/\p{L}/gu) || []).length;

  // One-page notes/syllabus can be short but perfectly valid — don’t force OCR
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

async function tryPdf2picAll(buffer, maxPages, pageCount, onStage) {
  let tmp;
  try {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lkpdf-'));
    const { fromBuffer } = await import('pdf2pic');
    const convert = fromBuffer(buffer, {
      density: 200,
      saveFilename: 'p',
      savePath: tmp,
      format: 'png',
      width: 2000,
      height: 2000,
    });
    const out = [];
    const n = Math.min(Math.max(1, pageCount || 1), maxPages);
    for (let i = 1; i <= n; i++) {
      onStage?.(`Processing document pages (${i}/${n})…`);
      const result = await convert(i, { responseType: 'buffer' });
      const buf = result?.buffer ?? (result?.base64 ? Buffer.from(result.base64, 'base64') : null);
      if (!buf?.length) throw new Error('empty page buffer');
      out.push(buf);
    }
    return out;
  } catch (e) {
    logger.debug(`[pdfHybrid] pdf2pic unavailable or failed (${e.message}); using pdf-to-img`);
    return null;
  } finally {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function rasterWithPdfToImg(buffer, maxPages, onStage) {
  const { pdf } = await import('pdf-to-img');
  const doc = await pdf(buffer, { scale: 1.6 });
  const total = doc.length || maxPages;
  const n = Math.min(Math.max(1, total), maxPages);
  const buffers = [];
  for (let p = 1; p <= n; p++) {
    onStage?.(`Processing document pages (${p}/${n})…`);
    const image = await doc.getPage(p);
    buffers.push(image);
  }
  return buffers;
}

/**
 * @param {Buffer} buffer
 * @param {{ onStage?: (msg: string) => void }} [opts]
 * @returns {Promise<{ text: string, pages: number, usedOcr: boolean }>}
 */
export async function extractPdfHybrid(buffer, opts = {}) {
  const { onStage } = opts;

  onStage?.('Reading your PDF…');

  const normalized = normalizePdfBuffer(buffer);

  let text = '';
  let pages = 0;

  try {
    const data = await pdfParse(normalized);
    text = (data.text || '').trim();
    pages = data.numpages || 0;
  } catch (e) {
    logger.warn(`[pdfHybrid] pdf-parse failed (${e.message}); using pdf.js text extraction`);
    try {
      const fb = await extractTextViaPdfJs(normalized);
      text = (fb.text || '').trim();
      pages = fb.pages || 0;
    } catch (e2) {
      logger.warn(`[pdfHybrid] pdf.js text extraction failed: ${e2.message}`);
      const err = new Error('Could not parse this PDF. It may be corrupted or password-protected.');
      err.code = 'EXTRACTION_FAILED';
      throw err;
    }
  }

  // pdf-parse often returns empty or tiny text for valid digital PDFs; pdf.js text layer is more reliable
  if (isWeakPdfTextExtract(text, pages) && text.length < 120) {
    try {
      const fb = await extractTextViaPdfJs(normalized);
      const t2 = (fb.text || '').trim();
      if (t2.length > text.length + 15) {
        text = t2;
        pages = fb.pages || pages;
        logger.debug(`[pdfHybrid] pdf.js text layer improved extract (${text.length} chars)`);
      }
    } catch (e) {
      logger.debug(`[pdfHybrid] pdf.js supplement skipped: ${e.message}`);
    }
  }

  if (!isWeakPdfTextExtract(text, pages)) {
    return { text, pages: pages || 1, usedOcr: false };
  }

  if (normalized.length > MAX_OCR_BYTES) {
    const err = new Error(
      'This PDF is too large for automatic OCR on the server. Try a smaller file (fewer pages or lower scan resolution), or split the document.',
    );
    err.code = 'PDF_TOO_LARGE_FOR_OCR';
    throw err;
  }

  onStage?.('We detected a scanned PDF — extracting text with OCR…');

  const pageCount = Math.max(1, pages || 1);
  const maxPages = Math.min(pageCount, MAX_OCR_PAGES);

  let pageBuffers = await tryPdf2picAll(normalized, maxPages, pageCount, onStage);
  if (!pageBuffers?.length) {
    onStage?.('Preparing pages for OCR…');
    pageBuffers = await rasterWithPdfToImg(normalized, maxPages, onStage);
  }

  if (!pageBuffers?.length) {
    const err = new Error('Could not render PDF pages for OCR.');
    err.code = 'OCR_FAILED';
    throw err;
  }

  onStage?.('Extracting text using OCR…');

  const worker = await createWorker('eng');
  const parts = [];
  const t0 = Date.now();

  try {
    for (let i = 0; i < pageBuffers.length; i++) {
      if (Date.now() - t0 > OCR_TOTAL_MS) {
        const err = new Error(
          'OCR ran too long for this document. Try fewer pages, a smaller file, or a text-based PDF export.',
        );
        err.code = 'OCR_TIMEOUT';
        throw err;
      }
      onStage?.(`Extracting text using OCR… page ${i + 1} of ${pageBuffers.length}`);
      const pageBuf = pageBuffers[i];
      const { data: ocrData } = await Promise.race([
        worker.recognize(pageBuf),
        new Promise((_, rej) => {
          setTimeout(() => {
            const er = new Error('A page took too long to OCR.');
            er.code = 'OCR_PAGE_TIMEOUT';
            rej(er);
          }, OCR_PAGE_MS);
        }),
      ]);
      const chunk = (ocrData?.text || '').trim();
      if (chunk) parts.push(chunk);
    }
  } finally {
    await worker.terminate().catch(() => {});
  }

  const merged = parts.join('\n\n').trim();
  if (!merged || merged.length < 40) {
    const err = new Error(
      'OCR could not read enough text from this PDF. Try a clearer scan or a text-based export.',
    );
    err.code = 'NO_TEXT';
    throw err;
  }

  onStage?.('Preparing educational content for indexing…');

  return { text: merged, pages: pageBuffers.length, usedOcr: true };
}
