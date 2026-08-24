import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { createPrismaClient } from '@businessos/database';
import { Queue } from 'bullmq';
import { QUEUE_NAMES, QUEUE_POLICIES, type QueueName } from './queues.js';
import { startDrainer } from './outbox-drainer.js';

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'),
  override: false,
  quiet: true,
});

/**
 * The worker process — report Section 4.1.
 *
 * Split from the API not for scale but because the failure characteristics
 * differ: a request either succeeds or returns an error to a waiting human,
 * while a job retries on a schedule with nobody watching. Mixing them means a
 * slow report render competes with request handling for the same event loop.
 */

const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  base: { service: 'businessos-worker' },
  ...(process.env['NODE_ENV'] === 'production'
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l' },
        },
      }),
});

const redisUrl = process.env['REDIS_URL'];
const databaseUrl = process.env['DATABASE_URL'];

if (!redisUrl || !databaseUrl) {
  logger.fatal('REDIS_URL and DATABASE_URL are required. Copy .env.example to .env.');
  process.exit(1);
}

/**
 * BullMQ requires `maxRetriesPerRequest: null` on its connection.
 *
 * A blocking command (BRPOPLPUSH) legitimately waits for a long time; with a
 * retry cap, ioredis treats that wait as a failure and tears the connection
 * down mid-poll. This is the one place the API's failure-fast Redis settings
 * are deliberately inverted.
 */
const connection = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
  enableOfflineQueue: true,
});

const prisma = createPrismaClient({ databaseUrl });

/**
 * Placeholder handler.
 *
 * Real processors land with the modules that produce their jobs — the email
 * queue with invitations, the workflow queue with the approval engine. Wiring
 * them before those modules exist would be speculative.
 */
async function handleJob(job: Job): Promise<void> {
  logger.info(
    { queue: job.queueName, jobId: job.id, name: job.name, attempt: job.attemptsMade + 1 },
    'processing job',
  );
  // Handlers must be idempotent: this may be attempt 2 of a job whose first
  // attempt already committed its side effect (Section 14.3).
  await Promise.resolve();
}

const workers = (Object.values(QUEUE_NAMES) as QueueName[]).map((name) => {
  const policy = QUEUE_POLICIES[name];

  const worker = new Worker(name, handleJob, {
    connection,
    concurrency: policy.concurrency,
  });

  worker.on('failed', (job, error) => {
    const exhausted = job ? job.attemptsMade >= (job.opts.attempts ?? 1) : false;
    logger[exhausted ? 'error' : 'warn'](
      {
        queue: name,
        jobId: job?.id,
        attempt: job?.attemptsMade,
        // Section 15.3: a job that exhausted its retries is a dead letter and
        // needs a human, not another retry.
        deadLettered: exhausted,
        err: error,
      },
      exhausted ? 'job exhausted all retries' : 'job attempt failed',
    );
  });

  worker.on('error', (error) => logger.error({ queue: name, err: error }, 'worker error'));

  return worker;
});

/**
 * The outbox drainer runs here rather than in the API, because publishing is
 * background work with its own retry and failure characteristics — the same
 * reason the worker exists at all (ADR-001).
 */
const producerQueues = {
  email: new Queue(QUEUE_NAMES.EMAIL, { connection }),
  notifications: new Queue(QUEUE_NAMES.NOTIFICATIONS, { connection }),
  reports: new Queue(QUEUE_NAMES.REPORTS, { connection }),
};

const stopDrainer = startDrainer({ prisma, queues: producerQueues, logger });

logger.info(
  { queues: Object.values(QUEUE_NAMES), outboxDrainer: true, node: process.version },
  'businessos worker started',
);

/**
 * Graceful shutdown.
 *
 * `worker.close()` waits for in-flight jobs to finish rather than abandoning
 * them. An abandoned job stays locked until its lock expires, so it sits
 * invisible for minutes before another worker can pick it up.
 */
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'worker shutdown started');

  const timer = setTimeout(() => {
    logger.error('graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 30_000);
  timer.unref();

  stopDrainer();
  await Promise.allSettled(workers.map((w) => w.close()));
  await Promise.allSettled(Object.values(producerQueues).map((q) => q.close()));
  await Promise.allSettled([prisma.$disconnect(), connection.quit()]);

  clearTimeout(timer);
  logger.info('worker shutdown complete');
  process.exit(0);
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => void shutdown(signal));
}
