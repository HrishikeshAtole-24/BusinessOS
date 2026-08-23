import type { PermissionKey } from '@businessos/contracts';
import { ForbiddenError } from '@businessos/contracts';
import type { PrismaClient } from '@businessos/database';

/**
 * Tenant membership and permission resolution — report Sections 9.3 and 18.3.
 *
 * This is the single place that answers "may this user do this, here?", and the
 * order of the two questions matters:
 *
 *   1. Is there an ACTIVE membership linking this user to this organization?
 *   2. Do that membership's roles grant the required permission?
 *
 * Step 1 is the tenant boundary. Skipping it and checking only permissions is
 * the classic multi-tenant hole: an owner of org A holds `expense.approve`, and
 * without a membership check that permission would apply to org B's expenses.
 */

export interface MembershipContext {
  membershipId: string;
  organizationId: string;
  userId: string;
  roles: string[];
  /**
   * Effective permissions, compiled once per request into a Set (Section 26.1).
   * Set membership is O(1), so a handler can check several permissions without
   * re-querying or scanning an array.
   */
  permissions: ReadonlySet<PermissionKey>;
}

/**
 * Resolve the caller's context inside one organization.
 *
 * Returns `null` rather than throwing when there is no active membership. The
 * caller decides the response, and for tenant-scoped resources that response is
 * 404 — confirming "this org exists but is not yours" is itself a disclosure
 * (Section 32, IDOR).
 *
 * Deliberately NOT cached in Redis. Caching authorization data trades a
 * millisecond for the risk that a revoked role keeps working until a TTL
 * expires, and "the permission removal took effect 60 seconds later" is a
 * security incident, not a performance note. This is one indexed query on
 * (organization_id, user_id). Revisit only with explicit invalidation on every
 * role, membership and permission mutation.
 */
export async function resolveMembershipContext(
  prisma: PrismaClient,
  userId: string,
  organizationId: string,
): Promise<MembershipContext | null> {
  const membership = await prisma.membership.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    select: {
      id: true,
      status: true,
      organization: { select: { status: true } },
      roles: {
        select: {
          role: {
            select: {
              key: true,
              permissions: { select: { permission: { select: { key: true } } } },
            },
          },
        },
      },
    },
  });

  if (!membership || membership.status !== 'ACTIVE') return null;

  // A suspended or archived organization blocks every member, owner included.
  // Checked here rather than per-route so it cannot be forgotten on a new one.
  if (membership.organization.status !== 'ACTIVE') return null;

  const permissions = new Set<PermissionKey>();
  const roles: string[] = [];

  for (const membershipRole of membership.roles) {
    roles.push(membershipRole.role.key);
    for (const rolePermission of membershipRole.role.permissions) {
      permissions.add(rolePermission.permission.key as PermissionKey);
    }
  }

  return {
    membershipId: membership.id,
    organizationId,
    userId,
    roles,
    permissions,
  };
}

/**
 * Every organization this user can act in — the org switcher, and the
 * post-login landing decision.
 */
export async function listActiveMemberships(prisma: PrismaClient, userId: string) {
  const memberships = await prisma.membership.findMany({
    where: {
      userId,
      status: 'ACTIVE',
      organization: { status: 'ACTIVE' },
    },
    select: {
      organization: {
        select: { id: true, name: true, slug: true, timezone: true, currency: true },
      },
    },
    orderBy: { joinedAt: 'asc' },
  });

  return memberships.map((m) => m.organization);
}

/** Throwing form, for use inside a handler that has already resolved context. */
export function assertPermission(context: MembershipContext, permission: PermissionKey): void {
  if (!context.permissions.has(permission)) {
    throw new ForbiddenError('You do not have permission to perform this action.', {
      required: permission,
    });
  }
}

/** True when the context holds every listed permission. */
export function hasAllPermissions(
  context: MembershipContext,
  permissions: readonly PermissionKey[],
): boolean {
  return permissions.every((p) => context.permissions.has(p));
}
