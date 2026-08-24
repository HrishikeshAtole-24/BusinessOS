import { createHash } from 'node:crypto';
import type { Prisma } from '@businessos/database';
import type { NotificationPriority } from '@businessos/domain';
import { enqueue, queues } from '../../lib/queues.js';

/**
 * Notifications — report Section 3.1 and Section 15.2.
 *
 * Two channels with different guarantees, on purpose:
 *
 *   in-app  written inside the caller's transaction, so it is exactly as
 *           durable as the thing it describes. An approval that committed
 *           always has its notification.
 *   email   queued after commit, at-least-once, and allowed to fail. Losing an
 *           email is annoying; failing an approval because SMTP was down is
 *           worse.
 */

export interface NotifyInput {
  organizationId: string;
  /** User ids. Duplicates are collapsed. */
  recipientIds: readonly string[];
  type: string;
  title: string;
  body?: string;
  priority?: NotificationPriority;
  entityType?: string;
  entityId?: string;
  /** Relative path in the web app. */
  link?: string;
  /**
   * Stable string identifying this exact notification. Hashed into a dedupe
   * key so a retried job cannot put the same item in someone's bell twice.
   */
  dedupeOn?: string;
  /** Also send email. */
  email?: boolean;
}

/**
 * Short, stable hash of the dedupe input.
 *
 * SHA-256 truncated to 32 hex characters. Section 26.1 lists hashing for
 * deduplication; the column has a unique constraint on (recipientId,
 * dedupeKey), so the database — not application logic — is what actually
 * enforces uniqueness.
 */
function dedupeKey(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 32);
}

/**
 * Create in-app notifications.
 *
 * Takes a transaction client so the rows commit with whatever caused them.
 * `skipDuplicates` makes a replay a no-op rather than an error.
 */
export async function notify(tx: Prisma.TransactionClient, input: NotifyInput): Promise<number> {
  const recipients = [...new Set(input.recipientIds)].filter(Boolean);
  if (recipients.length === 0) return 0;

  const result = await tx.notification.createMany({
    data: recipients.map((recipientId) => ({
      organizationId: input.organizationId,
      recipientId,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      priority: input.priority ?? 'NORMAL',
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      link: input.link ?? null,
      dedupeKey: input.dedupeOn ? dedupeKey(`${recipientId}:${input.dedupeOn}`) : null,
    })),
    skipDuplicates: true,
  });

  return result.count;
}

/**
 * Queue the email side.
 *
 * Called AFTER the transaction commits, never inside it. Enqueueing within a
 * transaction that later rolls back would send mail about something that never
 * happened — the dual-write problem the outbox pattern exists to solve
 * (Section 14.2).
 */
export async function queueEmails(input: NotifyInput): Promise<void> {
  if (!input.email) return;

  for (const recipientId of new Set(input.recipientIds)) {
    await enqueue(
      queues.email,
      'notification',
      {
        organizationId: input.organizationId,
        recipientId,
        type: input.type,
        title: input.title,
        body: input.body,
        link: input.link,
      },
      // Same key as the in-app dedupe, so a retry collapses on both channels.
      input.dedupeOn
        ? { jobId: `email:${dedupeKey(`${recipientId}:${input.dedupeOn}`)}` }
        : undefined,
    );
  }
}

// ---------------------------------------------------------------------------
// Event helpers
// ---------------------------------------------------------------------------

/**
 * Users who can act on an approval step.
 *
 * A step names either one employee or a role. For a role, everyone holding it
 * is notified — pinning one person would create a bottleneck the moment they
 * are away, which is the same reason the step itself is left unresolved.
 */
export async function approverUserIds(
  tx: Prisma.TransactionClient,
  organizationId: string,
  step: { approverEmployeeId: string | null; approverRoleKey: string | null },
): Promise<string[]> {
  if (step.approverEmployeeId) {
    const employee = await tx.employee.findFirst({
      where: { id: step.approverEmployeeId, organizationId },
      select: { userId: true },
    });
    return employee?.userId ? [employee.userId] : [];
  }

  if (step.approverRoleKey) {
    const memberships = await tx.membership.findMany({
      where: {
        organizationId,
        status: 'ACTIVE',
        roles: { some: { role: { key: step.approverRoleKey } } },
      },
      select: { userId: true },
    });
    return memberships.map((m) => m.userId);
  }

  return [];
}
