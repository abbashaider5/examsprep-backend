/**
 * Rule-based curriculum topic expansion — no AI tokens.
 * Used before (or instead of) LLM expansion for common syllabus headings.
 */

const KEYWORD_CONCEPTS = [
  { re: /\bdecimal|tenth|hundredth|place\s*value\b/i, concepts: ['decimal place value', 'tenths', 'hundredths', 'comparing decimals', 'reading decimals'] },
  { re: /\bfraction|ratio|proportion\b/i, concepts: ['fractions', 'equivalent fractions', 'comparing fractions', 'ratio and proportion'] },
  { re: /\bsymmetry|shape|geometry|angle|triangle|rectangle|perimeter|area\b/i, concepts: ['2D shapes', 'symmetry', 'angles', 'perimeter and area'] },
  { re: /\baddition|subtraction|multiply|division|arithmetic\b/i, concepts: ['addition', 'subtraction', 'multiplication', 'division', 'word problems'] },
  { re: /\bmeasurement|length|mass|capacity|unit\b/i, concepts: ['units of measurement', 'converting units', 'length', 'mass', 'capacity'] },
  { re: /\bdata|graph|chart|pictograph|bar\b/i, concepts: ['reading graphs', 'data handling', 'pictographs', 'bar charts'] },
  { re: /\btime|clock|calendar\b/i, concepts: ['telling time', 'elapsed time', 'calendars'] },
  { re: /\bmoney|rupee|coin\b/i, concepts: ['money', 'counting money', 'making change'] },
  { re: /\bpattern|sequence|number\s*line\b/i, concepts: ['number patterns', 'sequences', 'number line'] },
  { re: /\balgebra|equation|variable|expression\b/i, concepts: ['algebraic expressions', 'simple equations', 'variables'] },
  { re: /\bpercentage|percent\b/i, concepts: ['percentages', 'percent of a number'] },
  { re: /\binteger|negative|positive\b/i, concepts: ['integers', 'number operations with integers'] },
];

function cleanHeading(title) {
  return String(title || '')
    .replace(/^(chapter|unit|lesson)\s*[\d.:]+\s*/i, '')
    .replace(/^\d+(\.\d+)*\s*/, '')
    .trim();
}

function titleToConceptPhrases(title) {
  const cleaned = cleanHeading(title);
  if (!cleaned || cleaned.length < 3) return [];
  const out = new Set();
  for (const { re, concepts } of KEYWORD_CONCEPTS) {
    if (re.test(cleaned)) concepts.forEach((c) => out.add(c));
  }
  if (out.size === 0) {
    const words = cleaned
      .replace(/[^\w\s-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !/^(and|the|for|from|with)$/i.test(w));
    if (words.length >= 2) out.add(words.slice(0, 4).join(' '));
    words.slice(0, 6).forEach((w) => out.add(w.toLowerCase()));
  }
  return [...out];
}

/**
 * @param {string[]} sectionTitles
 * @param {string[]} [teacherTopics]
 * @returns {{ conceptTopics: string[], teachingGuidance: string, source: 'local' }}
 */
export function expandCurriculumLocally(sectionTitles = [], teacherTopics = []) {
  const concepts = new Set();
  for (const t of teacherTopics) {
    const s = String(t || '').trim();
    if (s) concepts.add(s);
  }
  for (const title of sectionTitles) {
    for (const c of titleToConceptPhrases(title)) concepts.add(c);
  }
  const conceptTopics = [...concepts].slice(0, 24);
  const teachingGuidance = conceptTopics.length
    ? `Assess these concept areas. Do not ask chapter-name or syllabus-recall questions. Concepts: ${conceptTopics.slice(0, 12).join('; ')}.`
    : '';
  return { conceptTopics, teachingGuidance, source: 'local' };
}

export function localExpansionSufficient(expanded, minTopics = 6) {
  return Array.isArray(expanded?.conceptTopics) && expanded.conceptTopics.length >= minTopics;
}
