import JSZip from 'jszip';
import logger from '../utils/logger.js';

const EXT = (name = '') => name.split('.').pop()?.toLowerCase() || '';

/** Pull visible text nodes from OOXML (pptx / shared patterns) */
const extractTextFromOoxml = (xml) => {
  if (!xml || typeof xml !== 'string') return '';
  const parts = [];
  const re = /<a:t>([^<]*)<\/a:t>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const t = m[1].trim();
    if (t) parts.push(t);
  }
  return parts.join(' ');
};

/**
 * @param {Buffer} buffer
 * @param {string} originalName
 * @param {string} [mimetype]
 * @returns {Promise<{ text: string, pages: number, format: string }>}
 */
export const extractTextFromResourceBuffer = async (buffer, originalName = '', mimetype = '') => {
  const ext = EXT(originalName);
  const mt = (mimetype || '').toLowerCase();

  if (ext === 'txt' || mt === 'text/plain') {
    const text = buffer.toString('utf8').replace(/\u0000/g, '');
    return { text, pages: 0, format: 'txt' };
  }

  if (ext === 'pdf' || mt === 'application/pdf') {
    const err = new Error('PDF uploads are not supported. Save as Word (.docx) and upload again.');
    err.code = 'PDF_NOT_SUPPORTED';
    throw err;
  }

  if (ext === 'docx' || mt.includes('wordprocessingml')) {
    const mammoth = await import('mammoth');
    const res = await mammoth.extractRawText({ buffer });
    const text = (res.value || '').trim();
    if (res.messages?.length) {
      logger.debug(`[resourceTextExtraction] mammoth messages: ${res.messages.map(m => m.message).join('; ')}`);
    }
    return { text, pages: 0, format: 'docx' };
  }

  if (ext === 'pptx' || mt.includes('presentationml')) {
    const zip = await JSZip.loadAsync(buffer);
    const slideNames = Object.keys(zip.files)
      .filter((n) => /ppt\/slides\/slide\d+\.xml$/i.test(n))
      .sort((a, b) => {
        const na = Number(a.match(/slide(\d+)/i)?.[1] || 0);
        const nb = Number(b.match(/slide(\d+)/i)?.[1] || 0);
        return na - nb;
      });
    const chunks = [];
    for (const name of slideNames) {
      const file = zip.file(name);
      if (!file) continue;
      const xml = await file.async('string');
      const slideText = extractTextFromOoxml(xml);
      if (slideText) chunks.push(slideText);
    }
    const text = chunks.join('\n\n').trim();
    return { text, pages: slideNames.length, format: 'pptx' };
  }

  if (ext === 'ppt') {
    const err = new Error('LEGACY_PPT');
    err.code = 'LEGACY_PPT';
    throw err;
  }

  const err = new Error('UNSUPPORTED_FORMAT');
  err.code = 'UNSUPPORTED_FORMAT';
  throw err;
};

export const isSupportedResourceFilename = (originalName = '') => {
  const e = EXT(originalName);
  return ['docx', 'doc', 'pptx', 'ppt', 'txt'].includes(e);
};
