import type { Prisma } from '@businessos/database';

/**
 * Transactional outbox writer — report Section 14.2.
 *
 * The problem, concretely, as it existed in this codebase before this file:
 *
 *   await tx.expense.update(...)        // PostgreSQL
 *   await commit()
 *   await queue.add('email', ...)       // Redis — separate system
 *
 * A crash between the commit and the enqueue loses the email with no trace.
 * Moving the enqueue inside the transaction is worse: a later rollback would
 * leave a queued job announcing something that never happened. No ordering of
 * two systems fixes this, because there is no transaction spanning them.
 *
 * The outbox makes it one atomic act. The event is a row in the same database,
 * written in the same transaction as the change, so it commits or vanishes with
 * it. A worker then reads the table and publishes.
 *
 * That handoff is at-least-once — the worker can publish and crash before
 * marking the row processed — which is precisely why Section 14.3 requires
 * every consumer to be idempotent.
 */

/** Past tense, `<aggregate>.<event>`. */
export type DomainEventType =
  | 'expense.submitted'
  | 'expense.approved'
  | 'expense.rejected'
  | 'expense.reimbursed'
  | 'leave.requested'
  | 'leave.approved'
  | 'leave.rejected'
  | 'approval.requested'
  | 'approval.resolved'
  | 'task.completed'
  | 'employee.created'
  | 'member.invited';

export interface DomainEvent {
  organizationId: string;
  type: DomainEventType;
  aggregateType: string;
  aggregateId: string;
  /**
   * Everything a consumer needs, captured NOW.
   *
   * Consumers must not re-read the aggregate: by the time the event is
   * processed the row may have changed again, and the event describes what
   * happened then, not what is true later.
   */
  payload: Record<string, unknown>;
  requestId?: string | null;
}

/**
 * Append an event to the outbox.
 *
 * Takes a transaction client and nothing else — there is no variant that takes
 * the base client, because writing an event outside the transaction that caused
 * it reintroduces the exact bug this exists to prevent.
 */
export async function publish(tx: Prisma.TransactionClient, event: DomainEvent): Promise<void> {
  await tx.outboxEvent.create({
    data: {
      organizationId: event.organizationId,
      type: event.type,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      payload: event.payload as Prisma.InputJsonValue,
      requestId: event.requestId ?? null,
    },
  });
}

/** Append several events atomically. */
export async function publishAll(
  tx: Prisma.TransactionClient,
  events: readonly DomainEvent[],
): Promise<void> {
  if (events.length === 0) return;
  await tx.outboxEvent.createMany({
    data: events.map((event) => ({
      organizationId: event.organizationId,
      type: event.type,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      payload: event.payload as Prisma.InputJsonValue,
      requestId: event.requestId ?? null,
    })),
  });
}
