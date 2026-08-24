import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

/**
 * BullMQ producers (report Section 15.2).
 *
 * The worker owns the consumers; this is the API side that enqueues.
 *
 * A SEPARATE Redis connection from `lib/redis.ts`, and deliberately so. The
 * cache client is configured to fail fast (`maxRetriesPerRequest: 3`,
 * `enableOfflineQueue: false`) because a slow cache should degrade rather than
 * block a request. BullMQ needs the opposite — `maxRetriesPerRequest: null` —
 * because its blocking commands legitimately wait a long time and a retry cap
 * tears the connection down mid-poll. Sharing one connection would force one of
 * those two to be wrong.
 */
const connection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableOfflineQueue: true,
  lazyConnect: true,
});

connection.on('error', (error: Error) => {
  logger.warn({ err: error }, 'queue connection error');
});

export const QUEUE_NAMES = {
  EMAIL: 'email',
  NOTIFICATIONS: 'notifications',
  REPORTS: 'reports',
  WORKFLOW: 'workflow',
  MAINTENANCE: 'maintenance',
} as const;

export const queues = {
  email: new Queue(QUEUE_NAMES.EMAIL, { connection }),
  notifications: new Queue(QUEUE_NAMES.NOTIFICATIONS, { connection }),
  reports: new Queue(QUEUE_NAMES.REPORTS, { connection }),
} as const;

/**
 * Enqueue without letting a queue outage fail the request.
 *
 * Section 29, graceful degradation: an approval decision that succeeded in the
 * database must not be reported as failed because the notification could not be
 * queued. The in-app notification row is already written inside the
 * transaction, so the user still sees it — only the email is lost, and that is
 * logged loudly.
 *
 * The honest fix is the transactional outbox (Section 14.2): write the intent
 * in the same transaction and let a worker drain it. This is the interim.
 */
export async function enqueue(
  queue: Queue,
  name: string,
  data: Record<string, unknown>,
  options?: { jobId?: string; delay?: number },
): Promise<boolean> {
  try {
    await queue.add(name, data, {
      // A stable jobId makes enqueueing idempotent: BullMQ refuses a second job
      // with an id it already holds, so a retried request cannot double-send.
      ...(options?.jobId ? { jobId: options.jobId } : {}),
      ...(options?.delay ? { delay: options.delay } : {}),
    });
    return true;
  } catch (error) {
    logger.error(
      { err: error, queue: queue.name, job: name, degraded: true },
      'failed to enqueue job; continuing without it',
    );
    return false;
  }
}

export async function closeQueues(): Promise<void> {
  await Promise.allSettled([...Object.values(queues).map((q) => q.close()), connection.quit()]);
}
