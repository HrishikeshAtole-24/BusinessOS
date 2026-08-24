import type { Queue } from 'bullmq';
import type { PrismaClient } from '@businessos/database';
import type { Logger } from 'pino';

/**
 * Outbox drainer — the publish half of Section 14.2.
 *
 * Polls `outbox_events` for due work, publishes each event to the queues that
 * care, and marks it processed. Runs on an interval rather than reacting to a
 * notification, because polling one indexed table every few seconds is simple
 * and cannot miss an event that arrived while a listener was reconnecting.
 *
 * Three properties make this safe to run in more than one process:
 *
 *   1. **Claiming.** Rows are moved to PROCESSING with a conditional
 *      `updateMany` before any work happens, so two drainers cannot take the
 *      same batch — the second update matches zero rows.
 *   2. **At-least-once.** Publishing can succeed and marking can fail, so an
 *      event may be delivered twice. Consumers must be idempotent
 *      (Section 14.3); the queue jobs below carry a deterministic jobId so
 *      BullMQ collapses the duplicate.
 *   3. **Backoff.** A failing event is rescheduled with exponential delay
 *      rather than retried immediately, so one poisoned row cannot spin the
 *      drainer.
 */

const BATCH_SIZE = 50;
const MAX_ATTEMPTS = 8;

export interface DrainerDeps {
  prisma: PrismaClient;
  queues: { email: Queue; notifications: Queue; reports: Queue };
  logger: Logger;
}

/** Which queues an event fans out to. */
function routeEvent(type: string): Array<'email' | 'notifications'> {
  switch (type) {
    case 'approval.requested':
      return ['email', 'notifications'];
    case 'expense.approved':
    case 'expense.rejected':
    case 'expense.reimbursed':
    case 'leave.approved':
    case 'leave.rejected':
    case 'approval.resolved':
      return ['email', 'notifications'];
    case 'member.invited':
      return ['email'];
    default:
      return ['notifications'];
  }
}

/**
 * Exponential backoff with a ceiling.
 *
 * 2s, 4s, 8s … capped at five minutes. Without a cap the delay grows past any
 * useful recovery window; without growth a broken dependency gets hammered.
 */
function backoffMs(attempts: number): number {
  return Math.min(2000 * 2 ** attempts, 5 * 60_000);
}

export async function drainOnce(deps: DrainerDeps): Promise<number> {
  const { prisma, queues, logger } = deps;
  const now = new Date();

  // Pick candidates, then claim them. The claim is what makes concurrent
  // drainers safe: only one `updateMany` can match a given row.
  const candidates = await prisma.outboxEvent.findMany({
    where: { status: 'PENDING', availableAt: { lte: now } },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: BATCH_SIZE,
  });
  if (candidates.length === 0) return 0;

  const ids = candidates.map((c) => c.id);
  const claimed = await prisma.outboxEvent.updateMany({
    where: { id: { in: ids }, status: 'PENDING' },
    data: { status: 'PROCESSING' },
  });
  if (claimed.count === 0) return 0;

  const events = await prisma.outboxEvent.findMany({
    where: { id: { in: ids }, status: 'PROCESSING' },
    select: {
      id: true,
      organizationId: true,
      type: true,
      aggregateType: true,
      aggregateId: true,
      payload: true,
      attempts: true,
      requestId: true,
    },
  });

  let published = 0;

  for (const event of events) {
    try {
      for (const target of routeEvent(event.type)) {
        await queues[target].add(
          event.type,
          {
            organizationId: event.organizationId,
            aggregateType: event.aggregateType,
            aggregateId: event.aggregateId,
            payload: event.payload,
            requestId: event.requestId,
          },
          {
            // Deterministic from the outbox row, so a redelivery collapses into
            // the job already queued instead of duplicating the side effect.
            jobId: `outbox:${event.id}:${target}`,
            attempts: 5,
            backoff: { type: 'exponential', delay: 2000 },
            removeOnComplete: { age: 86_400, count: 1000 },
            removeOnFail: false,
          },
        );
      }

      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: { status: 'PROCESSED', processedAt: new Date() },
      });
      published += 1;
    } catch (error) {
      const attempts = event.attempts + 1;
      const exhausted = attempts >= MAX_ATTEMPTS;

      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          // Exhausted rows go to FAILED and stay for inspection and replay
          // (Section 15.3) rather than being retried forever.
          status: exhausted ? 'FAILED' : 'PENDING',
          attempts,
          lastError: String(error).slice(0, 500),
          availableAt: new Date(Date.now() + backoffMs(attempts)),
        },
      });

      logger[exhausted ? 'error' : 'warn'](
        { err: error, outboxId: event.id, type: event.type, attempts, exhausted },
        exhausted ? 'outbox event exhausted its attempts' : 'outbox publish failed, will retry',
      );
    }
  }

  return published;
}

/**
 * Recover rows stuck in PROCESSING.
 *
 * A drainer that crashes mid-batch leaves its claim behind, and nothing would
 * ever pick those rows up again. Anything claimed longer than the timeout is
 * assumed abandoned and returned to PENDING — at-least-once delivery is what
 * makes that safe.
 */
export async function recoverStuck(deps: DrainerDeps, olderThanMs = 5 * 60_000): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const result = await deps.prisma.outboxEvent.updateMany({
    where: { status: 'PROCESSING', createdAt: { lt: cutoff } },
    data: { status: 'PENDING' },
  });
  if (result.count > 0) {
    deps.logger.warn({ recovered: result.count }, 'returned stuck outbox events to pending');
  }
  return result.count;
}

/** Run the drainer on an interval until stopped. */
export function startDrainer(deps: DrainerDeps, intervalMs = 3000): () => void {
  let stopped = false;
  let running = false;

  const tick = async () => {
    // Skip rather than overlap: a slow batch must not have a second drainer
    // started behind it in the same process.
    if (stopped || running) return;
    running = true;
    try {
      const published = await drainOnce(deps);
      if (published > 0) deps.logger.info({ published }, 'outbox drained');
    } catch (error) {
      deps.logger.error({ err: error }, 'outbox drain failed');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  const recovery = setInterval(() => void recoverStuck(deps), 60_000);

  return () => {
    stopped = true;
    clearInterval(timer);
    clearInterval(recovery);
  };
}
