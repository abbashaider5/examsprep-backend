import { Filter } from 'bad-words';
import hindiWords from '../data/hindiAbusiveWords.json' with { type: 'json' };
import hinglishWords from '../data/hinglishAbusiveWords.json' with { type: 'json' };

const englishFilter = new Filter();

const replacementMap = {
  '@': 'a',
  '$': 's',
  '5': 's',
  '0': 'o',
  '1': 'i',
  '!': 'i',
  '3': 'e',
  '4': 'a',
  '7': 't',
  '+': 't',
  '#': '',
  '*': '',
};

const mapChars = (text = '') => text.split('').map((char) => replacementMap[char] ?? char).join('');
const collapseRepeats = (text = '') => text.replace(/(.)\1{2,}/g, '$1');

export function normalizeForModeration(rawText = '') {
  let text = (rawText || '').toString().toLowerCase();
  text = mapChars(text);
  text = text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  text = text.replace(/[_~`^=]/g, ' ');
  text = text.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  text = collapseRepeats(text);
  text = text.replace(/\s+/g, ' ').trim();

  const compact = text.replace(/\s+/g, '');
  return { normalized: text, compact };
}

function hasEnglishAbuse(normalizedText) {
  const tokens = normalizedText.split(/\s+/).filter(Boolean);
  return tokens.filter((token) => englishFilter.isProfane(token));
}

function detectWordListMatches(list, normalizedText, compactText) {
  const detected = [];
  for (const term of list) {
    const normalizedTerm = normalizeForModeration(term).normalized;
    if (!normalizedTerm) continue;
    const compactTerm = normalizedTerm.replace(/\s+/g, '');

    const latinOnly = /^[a-z0-9\s]+$/i.test(normalizedTerm);
    const escaped = normalizedTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const termRegex = latinOnly ? new RegExp(`\\b${escaped}\\b`, 'i') : new RegExp(escaped, 'i');

    if (termRegex.test(normalizedText) || (compactTerm && compactText.includes(compactTerm))) {
      detected.push(term);
    }
  }
  return detected;
}

export function detectAbusiveContent(messageText = '') {
  const { normalized, compact } = normalizeForModeration(messageText);
  if (!normalized) return { isAbusive: false, normalized, detected: [] };

  const englishDetected = hasEnglishAbuse(normalized);
  const hindiDetected = detectWordListMatches(hindiWords, normalized, compact);
  const hinglishDetected = detectWordListMatches(hinglishWords, normalized, compact);
  const detected = [...new Set([...englishDetected, ...hindiDetected, ...hinglishDetected])];

  return {
    isAbusive: detected.length > 0,
    normalized,
    detected,
  };
}
