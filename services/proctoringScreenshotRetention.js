import Screenshot from '../models/Screenshot.js';
import logger from '../utils/logger.js';
import { deleteCloudinaryScreenshot } from './cloudinaryService.js';

export const PROCTORING_SCREENSHOT_RETENTION_DAYS = 14;

/**
 * Deletes proctoring screenshot evidence older than retention window.
 * Removes Cloudinary assets when publicId is stored; leaves Result.proctoringEvents intact.
 */
export async function cleanupExpiredProctoringScreenshots() {
  const cutoff = new Date(Date.now() - PROCTORING_SCREENSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const batch = await Screenshot.find({ capturedAt: { $lt: cutoff } })
    .select('_id cloudinaryPublicId')
    .limit(200)
    .lean();

  if (!batch.length) return { deleted: 0 };

  let deleted = 0;
  for (const row of batch) {
    try {
      if (row.cloudinaryPublicId) {
        await deleteCloudinaryScreenshot(row.cloudinaryPublicId);
      }
      await Screenshot.deleteOne({ _id: row._id });
      deleted += 1;
    } catch (e) {
      logger.warn(`[ProctoringRetention] Failed to delete screenshot ${row._id}: ${e.message}`);
    }
  }
  if (deleted) {
    logger.info(`[ProctoringRetention] Removed ${deleted} expired screenshot(s) (cutoff ${cutoff.toISOString()})`);
  }
  return { deleted };
}

export function scheduleProctoringScreenshotCleanup() {
  const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
  const run = () => {
    cleanupExpiredProctoringScreenshots().catch((e) => {
      logger.warn(`[ProctoringRetention] Cleanup run failed: ${e.message}`);
    });
  };
  run();
  return setInterval(run, SIX_HOURS_MS);
}
