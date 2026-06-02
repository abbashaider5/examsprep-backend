import crypto from 'node:crypto';
import CurriculumConceptCache from '../models/CurriculumConceptCache.js';
import Resource from '../models/Resource.js';
import logger from '../utils/logger.js';
import { recordCacheHit, recordCacheMiss } from './ai/aiRequestTrace.js';

export async function computeCurriculumSourceFingerprint(board, classLevel, subject) {
  const resources = await Resource.find({
    scope: 'admin',
    board,
    classLevel,
    subject,
    processingStatus: 'ready',
  })
    .select('_id updatedAt chunkCount processedAt')
    .sort({ _id: 1 })
    .lean();

  if (!resources.length) return 'empty';

  const payload = resources.map((r) => `${r._id}:${r.chunkCount || 0}:${r.updatedAt?.getTime?.() || r.processedAt?.getTime?.() || 0}`).join('|');
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

export async function getCachedCurriculumConcepts({ board, classLevel, subject, sourceFingerprint }) {
  const doc = await CurriculumConceptCache.findOne({
    board,
    classLevel,
    subject,
    sourceFingerprint,
  }).lean();

  if (!doc) {
    recordCacheMiss('curriculum_concepts');
    return null;
  }

  recordCacheHit('curriculum_concepts');
  return {
    conceptTopics: doc.conceptTopics || [],
    teachingGuidance: doc.teachingGuidance || '',
    sectionTitles: doc.sectionTitles || [],
    expansionSource: doc.expansionSource || 'ai',
    fromCache: true,
  };
}

export async function saveCachedCurriculumConcepts({
  board, classLevel, subject, sourceFingerprint, conceptTopics, teachingGuidance, sectionTitles, expansionSource,
}) {
  await CurriculumConceptCache.findOneAndUpdate(
    { board, classLevel, subject, sourceFingerprint },
    {
      board,
      classLevel,
      subject,
      sourceFingerprint,
      conceptTopics,
      teachingGuidance,
      sectionTitles: sectionTitles || [],
      expansionSource: expansionSource || 'ai',
      expandedAt: new Date(),
    },
    { upsert: true, new: true },
  );
}

export async function invalidateCurriculumConceptCache({ board, classLevel, subject } = {}) {
  const filter = {};
  if (board) filter.board = board;
  if (classLevel) filter.classLevel = classLevel;
  if (subject) filter.subject = subject;
  if (!Object.keys(filter).length) return;
  const r = await CurriculumConceptCache.deleteMany(filter);
  if (r.deletedCount > 0) {
    logger.info(`[curriculumCache] invalidated ${r.deletedCount} entries`, filter);
  }
}
