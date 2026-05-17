/**
 * Normalize OCR / parser noise and collapse redundant whitespace.
 */
export const cleanExtractedText = (raw) => {
  if (!raw || typeof raw !== 'string') return '';
  let t = raw.replace(/\r\n/g, '\n');
  t = t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  t = t.replace(/[^\S\n]+/g, ' ');
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
  const deduped = [];
  let prev = '';
  for (const line of lines) {
    if (line === prev) continue;
    deduped.push(line);
    prev = line;
  }
  return deduped.join('\n').trim();
};

/** PDF text-layer cleanup before chunking (hyphenation, spacing). */
export const cleanPdfExtractedText = (raw) => {
  if (!raw || typeof raw !== 'string') return '';
  let t = raw.replace(/\r\n/g, '\n');
  t = t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFEFF]/g, '');
  t = t.replace(/(\p{L})-\n(\p{L})/gu, '$1$2');
  t = t.replace(/[ \t]{2,}/g, ' ');
  return cleanExtractedText(t);
};

/**
 * Extra normalization after Tesseract: OCR noise, odd breaks, and junk lines before chunking/embeddings.
 */
export const cleanOcrExtractedText = (raw) => {
  if (!raw || typeof raw !== 'string') return '';
  let t = raw.replace(/\r\n/g, '\n');
  t = t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFEFF]/g, '');
  t = t.replace(/\uFFFD/g, '');
  t = t.replace(/[ \t]{2,}/g, ' ');
  t = t.replace(/\n[ \t]+/g, '\n');
  t = t.replace(/[ \t]+\n/g, '\n');
  t = t.replace(/\n{3,}/g, '\n\n');
  t = t.replace(/([a-z])-\n([a-z])/gi, '$1$2');
  const lines = t
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => {
      if (!l) return false;
      if (/^[^\p{L}\p{N}\s]+$/u.test(l) && l.length < 48) return false;
      if (/^[\-|_=•·]{3,}$/.test(l)) return false;
      return true;
    });
  return cleanExtractedText(lines.join('\n'));
};

const looksLikeHeading = (line) => {
  if (!line || line.length > 160) return false;
  const md = line.match(/^(#{1,4})\s+(.+)/);
  if (md) return { title: md[2].trim(), level: md[1].length };
  if (/^chapter\s+\d+/i.test(line)) return { title: line.trim(), level: 1 };
  if (/^\d+(\.\d+)*\s+[\p{L}]/u.test(line) && line.length < 120) return { title: line.trim(), level: 2 };
  if (line.length < 80 && line === line.toUpperCase() && /[A-Z]/.test(line)) return { title: line.trim(), level: 2 };
  return null;
};

/**
 * Heuristic structure pass for future chapter/topic filters.
 */
export const detectStructureOutline = (cleaned) => {
  const outline = [];
  if (!cleaned) return outline;
  let offset = 0;
  for (const para of cleaned.split('\n')) {
    const line = para.trim();
    const h = looksLikeHeading(line);
    if (h) outline.push({ title: h.title, level: h.level, approxCharOffset: offset });
    offset += line.length + 1;
  }
  return outline.slice(0, 200);
};

const MAX_DOC_CHARS = 450_000;

/**
 * Paragraph-aware chunks with overlap for RAG continuity.
 * @param {string} cleaned
 * @param {{ maxChars?: number, overlap?: number }} [opts]
 */
export const chunkTextForEmbedding = (cleaned, opts = {}) => {
  const maxChars = opts.maxChars ?? 1900;
  const overlap = opts.overlap ?? 220;
  const text = cleaned.length > MAX_DOC_CHARS ? cleaned.slice(0, MAX_DOC_CHARS) : cleaned;
  if (!text) return [];

  const paragraphs = text.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  const merged = [];
  let buf = '';
  const flush = () => {
    if (buf.trim()) merged.push(buf.trim());
    buf = '';
  };
  for (const p of paragraphs) {
    if ((buf + '\n\n' + p).length > maxChars * 0.85 && buf.length > 400) {
      flush();
      buf = p;
    } else {
      buf = buf ? `${buf}\n\n${p}` : p;
    }
    while (buf.length > maxChars * 1.25) {
      const slice = buf.slice(0, maxChars);
      const cut = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf('. '), slice.lastIndexOf(' '));
      const at = cut > maxChars * 0.5 ? cut + 1 : maxChars;
      merged.push(buf.slice(0, at).trim());
      const tail = buf.slice(Math.max(0, at - overlap));
      buf = tail;
    }
  }
  flush();

  const chunks = [];
  let carrySection = '';
  for (let raw of merged) {
    let offsetInRaw = 0;
    while (raw.length > maxChars) {
      const slice = raw.slice(0, maxChars);
      const cut = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf('. '));
      const at = cut > maxChars * 0.55 ? cut + 1 : maxChars;
      const piece = raw.slice(0, at).trim();
      const headingLine = piece.split('\n')[0]?.trim() || '';
      const h = looksLikeHeading(headingLine);
      if (h) carrySection = h.title;
      chunks.push({ text: piece, sectionTitle: carrySection });
      raw = raw.slice(Math.max(0, at - overlap)).trim();
      offsetInRaw += at;
    }
    if (raw) {
      const headingLine = raw.split('\n')[0]?.trim() || '';
      const h = looksLikeHeading(headingLine);
      if (h) carrySection = h.title;
      chunks.push({ text: raw, sectionTitle: carrySection });
    }
  }

  return chunks.map((c, i) => ({
    ...c,
    chunkIndex: i,
    charCount: c.text.length,
  }));
};
