import logger from './logger.js';

/**
 * Keep async work alive on Vercel after the HTTP response (waitUntil).
 * Falls back to setImmediate locally.
 * @param {() => Promise<void>} work
 */
export function scheduleBackgroundWork(work) {
  const task = Promise.resolve()
    .then(work)
    .catch((err) => {
      logger.error(`[backgroundTask] Unhandled: ${err?.message || err}`);
    });

  if (process.env.VERCEL) {
    import('@vercel/functions')
      .then(({ waitUntil }) => {
        waitUntil(task);
      })
      .catch((err) => {
        logger.warn(`[backgroundTask] waitUntil unavailable (${err?.message}); running inline`);
        return task;
      });
    return;
  }

  setImmediate(() => {
    void task;
  });
}
