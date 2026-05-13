import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { gunzipSync } from 'node:zlib';
import { URL } from 'node:url';

const DEFAULT_MAX_BYTES = 40 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_RETRIES = 3;
const MAX_REDIRECTS = 12;

try {
  if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
  }
} catch {
  /* ignore */
}

/** Avoid compressed binary bodies on Node https (no auto-inflate); also sidesteps rare fetch+gzip issues on PDF. */
const commonHeaders = {
  Accept: '*/*',
  'Accept-Encoding': 'identity',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

function isCloudinaryHost(hostname) {
  return typeof hostname === 'string' && hostname.toLowerCase().includes('cloudinary.com');
}

function maybeDecompressBody(buffer, res) {
  const enc = String(res.headers['content-encoding'] || '').toLowerCase();
  if (enc.includes('gzip') && buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    try {
      return gunzipSync(buffer);
    } catch {
      return buffer;
    }
  }
  return buffer;
}

/**
 * Node http(s).get with redirects; optional gzip decompress if server ignores identity.
 */
function downloadViaNodeHttp(urlString, maxBytes, timeoutMs) {
  return new Promise((resolve, reject) => {
    const visit = (urlStr, redirectsLeft, totalRef) => {
      let u;
      try {
        u = new URL(urlStr);
      } catch (e) {
        reject(e);
        return;
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        reject(new Error('Only http(s) downloads are supported'));
        return;
      }
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.get(urlStr, { headers: commonHeaders }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
          res.resume();
          let next;
          try {
            next = new URL(res.headers.location, urlStr).href;
          } catch (e) {
            reject(e);
            return;
          }
          visit(next, redirectsLeft - 1, totalRef);
          return;
        }
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode || 'unknown'}`));
          return;
        }
        const chunks = [];
        res.on('data', (c) => {
          totalRef.n += c.length;
          if (totalRef.n > maxBytes) {
            req.destroy();
            reject(new Error('Download exceeded size limit'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          const buf = maybeDecompressBody(raw, res);
          if (buf.length > maxBytes) {
            reject(new Error('Download exceeded size limit'));
            return;
          }
          resolve(buf);
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        reject(new Error('Download timed out'));
      });
    };
    visit(urlString, MAX_REDIRECTS, { n: 0 });
  });
}

async function downloadUrlToBufferOnce(urlString, maxBytes, timeoutMs) {
  let u;
  try {
    u = new URL(urlString);
  } catch {
    throw new Error('Invalid download URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Only http(s) downloads are supported');
  }

  const tryFetch = async () => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(urlString, {
        redirect: 'follow',
        signal: controller.signal,
        headers: commonHeaders,
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const ab = await res.arrayBuffer();
      if (ab.byteLength > maxBytes) {
        throw new Error('Download exceeded size limit');
      }
      return Buffer.from(ab);
    } finally {
      clearTimeout(t);
    }
  };

  const cloudinary = isCloudinaryHost(u.hostname);

  /** Cloudinary raw PDF: prefer Node https first (stable TLS + identity); fetch as backup. Else fetch first. */
  if (cloudinary) {
    try {
      return await downloadViaNodeHttp(urlString, maxBytes, timeoutMs);
    } catch (httpErr) {
      try {
        return await tryFetch();
      } catch (fetchErr) {
        const a = httpErr?.message || String(httpErr);
        const b = fetchErr?.message || String(fetchErr);
        throw new Error(`${a} | fetch: ${b}`);
      }
    }
  }

  try {
    return await tryFetch();
  } catch (fetchErr) {
    try {
      return await downloadViaNodeHttp(urlString, maxBytes, timeoutMs);
    } catch (httpErr) {
      const a = fetchErr?.message || String(fetchErr);
      const b = httpErr?.message || String(httpErr);
      throw new Error(`${a} | fallback: ${b}`);
    }
  }
}

/**
 * Download a URL into a Buffer (retries, timeout, IPv4-first DNS).
 */
export async function downloadUrlToBuffer(urlString, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_RETRIES;

  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await downloadUrlToBufferOnce(urlString, maxBytes, timeoutMs);
    } catch (e) {
      lastErr = e;
      const msg = e?.name === 'AbortError' ? 'Download timed out' : (e?.message || String(e));
      if (attempt === maxRetries) {
        throw new Error(msg);
      }
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  throw lastErr;
}
