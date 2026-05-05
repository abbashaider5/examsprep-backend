/**
 * LLMs often emit raw U+0000–U+001F inside JSON string values (illegal in JSON).
 * This walks the slice and escapes those characters so JSON.parse succeeds.
 */
export function escapeControlCharsInJsonStrings(jsonSlice) {
  let out = '';
  let inString = false;
  let escape = false;
  for (let i = 0; i < jsonSlice.length; i += 1) {
    const c = jsonSlice[i];
    if (escape) {
      out += c;
      escape = false;
      continue;
    }
    if (c === '\\') {
      out += c;
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      out += c;
      continue;
    }
    if (inString) {
      const code = c.charCodeAt(0);
      if (code >= 0 && code < 0x20) {
        if (c === '\n') out += '\\n';
        else if (c === '\r') out += '\\r';
        else if (c === '\t') out += '\\t';
        else out += `\\u${code.toString(16).padStart(4, '0')}`;
        continue;
      }
    }
    out += c;
  }
  return out;
}

/** Remove common markdown fences so regex extraction works. */
export function stripAiMarkdownFences(text) {
  if (!text || typeof text !== 'string') return '';
  let t = text.trim();
  t = t.replace(/^```(?:json)?\s*/i, '');
  t = t.replace(/\s*```\s*$/i, '');
  return t.trim();
}

function extractBracket(text, open, close) {
  const start = text.indexOf(open);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === '\\' && inString) {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (c === open) depth += 1;
      else if (c === close) {
        depth -= 1;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Prefer balanced bracket extraction (avoids greedy-regex bugs), then sanitize + parse.
 */
export function parseAiJsonArray(rawText) {
  const text = stripAiMarkdownFences(rawText);
  const slice = extractBracket(text, '[', ']') || text.match(/\[[\s\S]*\]/)?.[0];
  if (!slice) throw new Error('AI did not return a JSON array');
  const cleaned = escapeControlCharsInJsonStrings(slice);
  return JSON.parse(cleaned);
}

export function parseAiJsonObject(rawText) {
  const text = stripAiMarkdownFences(rawText);
  const slice = extractBracket(text, '{', '}') || text.match(/\{[\s\S]*\}/)?.[0];
  if (!slice) throw new Error('AI did not return a JSON object');
  const cleaned = escapeControlCharsInJsonStrings(slice);
  return JSON.parse(cleaned);
}
