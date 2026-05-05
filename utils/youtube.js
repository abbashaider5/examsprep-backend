/**
 * Extract YouTube video id from common URL formats.
 * @param {string} url
 * @returns {string | null}
 */
export function parseYoutubeVideoId(url) {
  if (!url || typeof url !== 'string') return null;
  const u = url.trim();
  if (!u) return null;

  let m = u.match(/^https?:\/\/(?:www\.)?youtu\.be\/([a-zA-Z0-9_-]{11})(?:\?|&|$)/);
  if (m) return m[1];

  m = u.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (m) return m[1];

  m = u.match(/youtube\.com\/embed\/([a-zA-Z0-9_-]{11})(?:\?|&|$)/);
  if (m) return m[1];

  m = u.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})(?:\?|&|$)/);
  if (m) return m[1];

  return null;
}
