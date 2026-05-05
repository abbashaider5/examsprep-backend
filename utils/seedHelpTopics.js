import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import HelpTopic from '../models/HelpTopic.js';
import logger from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Which role each legacy article is meant for (strict visibility). */
const AUDIENCE_BY_TOPIC_ID = {
  'dashboard-overview': 'user',
  'create-tests': 'instructor',
  'manage-tests': 'instructor',
  'invite-students': 'instructor',
  'create-batches': 'instructor',
  'view-reports': 'instructor',
  'evaluate-answers': 'instructor',
  'take-exam': 'user',
  'study-mode-flashcards': 'user',
  certificates: 'user',
  'leaderboard-performance': 'user',
  'profile-settings': 'user',
  'pricing-plans': 'user',
  'tickets-support': 'user',
  notifications: 'user',
  'admin-overview': 'admin',
  'instructor-hub': 'instructor',
  'proctoring-basics': 'user',
  'results-page': 'user',
  'verify-certificate': 'user',
};

function resolveHelpJsonPath() {
  const candidates = [
    path.join(__dirname, '../../client/src/data/helpTopics.json'),
    path.join(__dirname, '../data/helpTopics.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Seed HelpTopic collection from bundled JSON when empty (first deploy / empty DB).
 */
export async function seedHelpTopicsIfEmpty() {
  try {
    const count = await HelpTopic.countDocuments();
    if (count > 0) return;

    const jsonPath = resolveHelpJsonPath();
    if (!jsonPath) {
      logger.warn('[help] seed skipped: helpTopics.json not found');
      return;
    }

    const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    if (!Array.isArray(raw) || raw.length === 0) return;

    const docs = raw.map((t) => {
      const topicId = t.id;
      const audience = AUDIENCE_BY_TOPIC_ID[topicId] || 'user';
      const { id: _idOmit, ...rest } = t;
      return {
        ...rest,
        topicId,
        audience,
      };
    });

    await HelpTopic.insertMany(docs);
    logger.info(`[help] seeded ${docs.length} help topics`);
  } catch (e) {
    logger.warn(`[help] seed failed: ${e.message}`);
  }
}
