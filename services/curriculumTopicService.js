import Resource from '../models/Resource.js';
import ResourceChunk from '../models/ResourceChunk.js';
import logger from '../utils/logger.js';
import { parseAiJsonObject } from '../utils/aiJsonParse.js';
import { aiChatCompletion, getConfiguredChatModel } from './ai/aiRequestClient.js';
import {
  computeCurriculumSourceFingerprint,
  getCachedCurriculumConcepts,
  saveCachedCurriculumConcepts,
} from './curriculumConceptCacheService.js';
import { expandCurriculumLocally, localExpansionSufficient } from './curriculumLocalExpansion.js';

function uniqueStrings(items, max = 40) {
  const seen = new Set();
  const out = [];
  for (const raw of items) {
    const s = String(raw || '').trim();
    if (!s || s.length < 2) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** Collect syllabus structure (headings/outlines) — not full lesson text for question copying. */
export async function collectCurriculumOutline({ board, classLevel, subject }) {
  const resources = await Resource.find({
    scope: 'admin',
    board,
    classLevel,
    subject,
    processingStatus: 'ready',
    chunkCount: { $gt: 0 },
  }).select('_id title').lean();

  if (!resources.length) {
    return { outline: '', sectionTitles: [], resourceIds: [] };
  }

  const resourceIds = resources.map((r) => r._id);
  const chunks = await ResourceChunk.find({ resource: { $in: resourceIds } })
    .select('sectionTitle text chunkIndex')
    .sort({ chunkIndex: 1 })
    .limit(150)
    .lean();

  const sectionTitles = new Set();
  const outlineLines = new Set();

  for (const c of chunks) {
    const st = String(c.sectionTitle || '').trim();
    if (st && st.length <= 120) sectionTitles.add(st);

    const lines = String(c.text || '').split(/\n+/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines.slice(0, 4)) {
      if (line.length > 100 || line.length < 3) continue;
      if (/^\d+(\.\d+)*\s*$/.test(line)) continue;
      if (/^page\s+\d+/i.test(line)) continue;
      outlineLines.add(line);
    }
  }

  const titles = [...sectionTitles];
  const notes = [...outlineLines].slice(0, 60);
  const outline = [
    `Board: ${board}`,
    `Class: ${classLevel}`,
    `Subject: ${subject}`,
    '',
    'Section / unit headings (for scope only — do not treat as question answers):',
    ...titles.map((t) => `- ${t}`),
    '',
    'Brief outline phrases from curriculum documents:',
    ...notes.map((n) => `- ${n}`),
  ].join('\n').slice(0, 6500);

  return {
    outline,
    sectionTitles: titles,
    resourceIds,
  };
}

/**
 * AI expansion — only when cache miss and local rules insufficient.
 */
export async function expandCurriculumToConceptGuidance({
  board, classLevel, subject, outline, teacherTopics = [], sectionTitles = [],
}) {
  const baseTopics = uniqueStrings(teacherTopics, 12);

  const local = expandCurriculumLocally(sectionTitles, baseTopics);
  if (localExpansionSufficient(local, 6)) {
    return { ...local, expansionSource: 'local' };
  }

  if (!outline || outline.length < 30) {
    return {
      conceptTopics: local.conceptTopics.length ? local.conceptTopics : baseTopics,
      teachingGuidance: local.teachingGuidance || (baseTopics.length ? `Focus on: ${baseTopics.join(', ')}.` : ''),
      expansionSource: 'local',
    };
  }

  const prompt = `You are a senior ${board} curriculum specialist for Class ${classLevel} ${subject}.

You receive a SYLLABUS OUTLINE (headings and short phrases only). Convert it into teachable CONCEPTS — not chapter titles.

Return ONLY valid JSON:
{
  "conceptTopics": ["decimal place value", "comparing tenths and hundredths", ...],
  "teachingGuidance": "2-5 sentences: what to include, exclude, and typical difficulty for this class"
}

Rules:
- conceptTopics: 8-24 short phrases (NOT chapter names).
- If a heading is "Tenths and Hundredths", expand to decimals, place value, tenths, hundredths — not only the chapter title.
- Merge teacher topics if provided: ${baseTopics.length ? baseTopics.join('; ') : 'none'}.

SYLLABUS OUTLINE:
"""
${outline}
"""`;

  try {
    const completion = await aiChatCompletion({
      model: getConfiguredChatModel(),
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.35,
      max_tokens: 1200,
    }, { operation: 'curriculum_topic_expand', purpose: 'Expand syllabus headings to concept topics (cached after first run)' });
    const text = completion.choices[0]?.message?.content?.trim();
    const parsed = parseAiJsonObject(text);
    const conceptTopics = uniqueStrings([
      ...local.conceptTopics,
      ...baseTopics,
      ...(Array.isArray(parsed.conceptTopics) ? parsed.conceptTopics : []),
    ], 24);
    const teachingGuidance = String(parsed.teachingGuidance || local.teachingGuidance || '').trim().slice(0, 2000);
    return { conceptTopics, teachingGuidance, expansionSource: 'ai' };
  } catch (err) {
    logger.warn(`[curriculumTopic] expand failed: ${err.message}`);
    const fallback = uniqueStrings([
      ...local.conceptTopics,
      ...baseTopics,
      ...outline.split('\n')
        .map((l) => l.replace(/^[-*]\s*/, '').trim())
        .filter((l) => l.length > 3 && l.length < 80),
    ], 16);
    return {
      conceptTopics: fallback,
      teachingGuidance: `Assess ${subject} concepts appropriate for ${board} Class ${classLevel}. Do not ask about chapter or unit names.`,
      expansionSource: 'local',
    };
  }
}

/**
 * Build concept topic pack for Web-source exams (cache → local → AI).
 */
export async function buildCurriculumTopicGuidanceForExam({
  board, classLevel, subject, teacherTopics = [],
}) {
  const { outline, sectionTitles, resourceIds } = await collectCurriculumOutline({
    board, classLevel, subject,
  });
  if (!outline && !sectionTitles.length) {
    return null;
  }

  const sourceFingerprint = await computeCurriculumSourceFingerprint(board, classLevel, subject);
  const cached = await getCachedCurriculumConcepts({ board, classLevel, subject, sourceFingerprint });
  if (cached?.conceptTopics?.length) {
    return {
      conceptTopics: cached.conceptTopics,
      teachingGuidance: cached.teachingGuidance,
      resourceIds,
      expansionSource: cached.expansionSource,
      fromCache: true,
    };
  }

  const expanded = await expandCurriculumToConceptGuidance({
    board,
    classLevel,
    subject,
    outline,
    teacherTopics,
    sectionTitles,
  });

  if (!expanded.conceptTopics.length && !expanded.teachingGuidance) {
    return null;
  }

  await saveCachedCurriculumConcepts({
    board,
    classLevel,
    subject,
    sourceFingerprint,
    conceptTopics: expanded.conceptTopics,
    teachingGuidance: expanded.teachingGuidance,
    sectionTitles,
    expansionSource: expanded.expansionSource || 'ai',
  });

  return {
    conceptTopics: expanded.conceptTopics,
    teachingGuidance: expanded.teachingGuidance,
    resourceIds,
    expansionSource: expanded.expansionSource,
    fromCache: false,
  };
}

/** Options for Web-source exams scoped by board/class/subject (no RAG question copying). */
export async function buildCurriculumWebAiOptions({
  board, classLevel, subject, teacherTopics = [],
}) {
  const pack = await buildCurriculumTopicGuidanceForExam({
    board, classLevel, subject, teacherTopics,
  });
  if (!pack) return null;

  const guidance = [
    pack.teachingGuidance,
    pack.conceptTopics.length
      ? `Generate questions on these concept areas (not chapter or unit titles):\n${
        pack.conceptTopics.map((t) => `- ${t}`).join('\n')
      }`
      : '',
  ].filter(Boolean).join('\n\n');

  return {
    curriculumWebMode: true,
    curriculumTopicGuidance: guidance,
    /** Cap topics in generation prompt — full list stays in guidance block */
    topics: pack.conceptTopics.length ? pack.conceptTopics.slice(0, 12) : teacherTopics,
    curriculumMeta: {
      fromCache: pack.fromCache,
      expansionSource: pack.expansionSource,
      topicCount: pack.conceptTopics.length,
    },
  };
}
