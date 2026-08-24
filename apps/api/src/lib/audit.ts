import type { Prisma, PrismaClient } from '@businessos/database';

/**
 * Audit logging — report Sections 10.2 and 33.
 *
 * Append-only: there is a `record` function and nothing else. No update path,
 * no delete path, not even an internal one. Section 33 is explicit that audit
 * records are never removed to tidy the UI, and the cheapest way to guarantee
 * that is to not write the code that could.
 */

export type AuditAction =
  // identity
  | 'user.registered'
  | 'user.logged_in'
  | 'user.login_failed'
  | 'user.logged_out'
  | 'session.revoked'
  // tenancy
  | 'organization.created'
  | 'organization.updated'
  | 'organization.switched'
  // membership and access
  | 'membership.created'
  | 'membership.role_assigned'
  | 'membership.suspended'
  | 'membership.removed'
  // people
  | 'department.created'
  | 'department.updated'
  | 'department.deleted'
  | 'employee.created'
  | 'employee.updated'
  | 'employee.exited'
  // work
  | 'project.created'
  | 'project.updated'
  | 'task.created'
  | 'task.updated'
  | 'task.status_changed'
  | 'task.dependency_added'
  // invitations
  | 'invitation.sent'
  | 'invitation.accepted'
  | 'invitation.revoked';

export interface AuditEntry {
  organizationId: string;
  /** Null for system and worker actions with no human actor. */
  actorId?: string | null;
  action: AuditAction;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  requestId?: string | null;
}

/**
 * Fields that must never reach the audit metadata column.
 *
 * The audit log is long-lived by design and widely readable (`audit.read` is
 * granted to HR, Finance and Admin). A secret written here is a secret retained
 * for years and exposed to more people than saw it originally — so this strips
 * rather than trusts the caller.
 */
const FORBIDDEN_METADATA_KEYS = new Set([
  'password',
  'passwordHash',
  'newPassword',
  'currentPassword',
  'token',
  'tokenHash',
  'sessionToken',
  'secret',
  'accessToken',
  'refreshToken',
]);

function sanitize(metadata: Record<string, unknown>): Prisma.InputJsonValue {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (FORBIDDEN_METADATA_KEYS.has(key)) continue;
    clean[key] = value;
  }
  // Prisma's InputJsonValue is narrower than Record<string, unknown> because it
  // excludes undefined and non-serialisable values. The cast is the boundary
  // between our shape and theirs; sanitize() above is what makes it safe.
  return clean as Prisma.InputJsonValue;
}

/**
 * Write an audit record.
 *
 * `client` accepts a transaction handle so the audit row commits atomically
 * with the change it describes (Section 11.1). Passing the base client instead
 * means a rolled-back operation can leave an audit entry claiming something
 * happened that did not — worse than no entry at all.
 */
export async function record(
  client: PrismaClient | Prisma.TransactionClient,
  entry: AuditEntry,
): Promise<void> {
  await client.auditLog.create({
    data: {
      organizationId: entry.organizationId,
      actorId: entry.actorId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      // Conditional spread rather than `: undefined` — under
      // exactOptionalPropertyTypes an absent key and an undefined value are
      // different types, and Prisma reads them as different intents.
      ...(entry.metadata ? { metadata: sanitize(entry.metadata) } : {}),
      ipAddress: entry.ipAddress ?? null,
      requestId: entry.requestId ?? null,
    },
  });
}

/**
 * Build a before/after diff for an update.
 *
 * Records only fields that actually changed, so the log answers "what changed"
 * rather than "here is the whole row again" — which is what makes an audit
 * trail readable a year later.
 */
export function diff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [key, next] of Object.entries(after)) {
    if (next === undefined) continue;
    const previous = before[key];
    if (previous !== next) changes[key] = { from: previous, to: next };
  }
  return changes;
}
