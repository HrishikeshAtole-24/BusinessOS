import type { JobsOptions } from 'bullmq';

/**
 * Queue taxonomy — report Section 15.2.
 *
 * Separate queues rather than one queue with a `type` field, because the whole
 * point is that these workloads fail differently. A stuck PDF render must not
 * delay a password-reset email, and a provider outage on one should not consume
 * the retry budget of another. Section 29 calls this bulkheading.
 */

export const QUEUE_NAMES = {
  EMAIL: 'email',
  NOTIFICATIONS: 'notifications',
  REPORTS: 'reports',
  WORKFLOW: 'workflow',
  MAINTENANCE: 'maintenance',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * Every job is retried with **exponential backoff plus jitter** (Section 29).
 *
 * Jitter is not decoration. Without it, a provider outage that fails 500 jobs
 * at once retries all 500 at the same instant, then again in lockstep — the
 * thundering herd that keeps a recovering service down. BullMQ's `exponential`
 * strategy is deterministic, so jitter is applied per-job at enqueue time.
 */
export function withJitter(baseDelayMs: number): number {
  // Full jitter: uniform in [0, base). Converges faster than equal jitter when
  // many clients contend, at the cost of occasionally retrying very soon.
  return Math.floor(Math.random() * baseDelayMs);
}

interface QueuePolicy {
  readonly defaultJobOptions: JobsOptions;
  /** How many jobs this queue may process at once. */
  readonly concurrency: number;
  readonly description: string;
}

/**
 * `removeOnComplete` is bounded rather than `true`. Keeping a recent window of
 * completed jobs makes "did that notification actually send?" answerable
 * without a separate audit query; keeping all of them would grow Redis without
 * limit, and Redis is memory.
 *
 * `removeOnFail: false` on the queues that touch money or identity — a job that
 * exhausted its retries must remain inspectable and replayable. That is the
 * dead-letter behaviour Section 15.3 asks for.
 */
export const QUEUE_POLICIES: Record<QueueName, QueuePolicy> = {
  [QUEUE_NAMES.EMAIL]: {
    description: 'Transactional email: invitations, approvals, password resets.',
    concurrency: 5,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: { age: 86_400, count: 1_000 },
      removeOnFail: false,
    },
  },

  [QUEUE_NAMES.NOTIFICATIONS]: {
    description: 'In-app notification fan-out.',
    concurrency: 10,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnComplete: { age: 3_600, count: 1_000 },
      removeOnFail: { age: 604_800 },
    },
  },

  [QUEUE_NAMES.REPORTS]: {
    description: 'PDF/CSV generation and scheduled exports.',
    // Low: report jobs are CPU- and memory-hungry, and running many at once is
    // the fastest way to make the worker's event loop unresponsive.
    concurrency: 2,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { age: 86_400, count: 100 },
      removeOnFail: false,
    },
  },

  [QUEUE_NAMES.WORKFLOW]: {
    description: 'Approval routing and automation actions.',
    concurrency: 5,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 604_800, count: 5_000 },
      // Never dropped: a lost workflow job leaves an approval stuck forever
      // with no record of why.
      removeOnFail: false,
    },
  },

  [QUEUE_NAMES.MAINTENANCE]: {
    description: 'Cleanup, aggregation, expiry sweeps.',
    concurrency: 1,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: { age: 86_400, count: 50 },
      removeOnFail: { age: 604_800 },
    },
  },
};

/**
 * Build a job ID that makes enqueueing idempotent.
 *
 * Section 14.3: assume at-least-once delivery and design for it. BullMQ will
 * not enqueue a second job with an ID that already exists, so deriving the ID
 * from the operation — not from a timestamp or a random value — means a
 * duplicated *publish* collapses into one job.
 *
 * This is only half of idempotency. It stops duplicate enqueues; it does not
 * stop a single job from running twice after a worker crashes mid-execution.
 * The handler itself must still be safe to repeat (Section 11.4) — via a unique
 * constraint on the side effect, or a state check before performing it.
 */
export function idempotentJobId(
  operation: string,
  entityId: string,
  discriminator?: string,
): string {
  return discriminator ? `${operation}:${entityId}:${discriminator}` : `${operation}:${entityId}`;
}
