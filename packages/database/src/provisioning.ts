import { SYSTEM_ROLES, permissionsForSystemRole, type SystemRoleKey } from '@businessos/contracts';
import type { Prisma } from './generated/client.js';

/**
 * Organization provisioning.
 *
 * Lives here rather than in the API because the seed needs it too, and a second
 * copy of "what a new organization looks like" would drift — leaving seeded
 * organizations and real ones subtly different, which is the worst kind of
 * environment bug to chase.
 *
 * Every function takes a transaction client. Creating an organization without
 * its roles, or with roles but no owner, leaves a tenant nobody can administer;
 * these steps are one atomic unit (Section 11.1).
 */

export interface ProvisionOrganizationInput {
  name: string;
  slug: string;
  timezone?: string;
  currency?: string;
  /** Becomes the owner. */
  ownerUserId: string;
}

export interface ProvisionedOrganization {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  currency: string;
  membershipId: string;
}

/**
 * Create the six system roles for an organization and wire their permissions.
 *
 * Reconciles rather than only inserting: grants are recomputed from the
 * catalogue and stale ones removed, so adding a permission and re-running this
 * updates existing organizations instead of leaving them behind.
 *
 * Wildcards are expanded to concrete keys before storage. A `leave.*` row in
 * `role_permissions` would silently widen the role the next time a permission
 * was added to the catalogue — grants must mean what they meant when granted.
 */
export async function provisionSystemRoles(
  tx: Prisma.TransactionClient,
  organizationId: string,
): Promise<Map<SystemRoleKey, string>> {
  const permissions = await tx.permission.findMany({ select: { id: true, key: true } });
  const permissionIds = new Map(permissions.map((p) => [p.key, p.id]));

  if (permissionIds.size === 0) {
    throw new Error(
      'The permission catalogue is empty. Run `pnpm db:seed` before creating organizations.',
    );
  }

  const roleIds = new Map<SystemRoleKey, string>();

  for (const definition of SYSTEM_ROLES) {
    const role = await tx.role.upsert({
      where: { organizationId_key: { organizationId, key: definition.key } },
      update: { name: definition.name, description: definition.description, isSystem: true },
      create: {
        organizationId,
        key: definition.key,
        name: definition.name,
        description: definition.description,
        isSystem: true,
      },
      select: { id: true },
    });

    roleIds.set(definition.key, role.id);

    const grantedIds: string[] = [];
    for (const key of permissionsForSystemRole(definition.key)) {
      const id = permissionIds.get(key);
      // A permission in the catalogue but not in the database means the seed is
      // stale. Fail loudly: a role quietly missing a permission is an
      // authorization bug that only surfaces as a confused user report.
      if (!id) throw new Error(`Permission "${key}" is missing from the database.`);
      grantedIds.push(id);
    }

    await tx.rolePermission.deleteMany({
      where: { roleId: role.id, permissionId: { notIn: grantedIds } },
    });
    await tx.rolePermission.createMany({
      data: grantedIds.map((permissionId) => ({ roleId: role.id, permissionId })),
      skipDuplicates: true,
    });
  }

  return roleIds;
}

/**
 * Create an organization, its system roles, and the founding owner membership.
 *
 * The owner assignment is not optional. An organization with no owner cannot
 * invite anyone or change its own settings, and recovering from that requires
 * direct database access.
 */
export async function provisionOrganization(
  tx: Prisma.TransactionClient,
  input: ProvisionOrganizationInput,
): Promise<ProvisionedOrganization> {
  const organization = await tx.organization.create({
    data: {
      name: input.name,
      slug: input.slug,
      timezone: input.timezone ?? 'Asia/Kolkata',
      currency: input.currency ?? 'INR',
    },
    select: { id: true, name: true, slug: true, timezone: true, currency: true },
  });

  const roleIds = await provisionSystemRoles(tx, organization.id);

  const ownerRoleId = roleIds.get('owner');
  if (!ownerRoleId) throw new Error('Owner role was not provisioned.');

  const membership = await tx.membership.create({
    data: {
      organizationId: organization.id,
      userId: input.ownerUserId,
      status: 'ACTIVE',
      roles: { create: { roleId: ownerRoleId } },
    },
    select: { id: true },
  });

  return { ...organization, membershipId: membership.id };
}

/** Assign a role to an existing membership. Idempotent. */
export async function assignRole(
  tx: Prisma.TransactionClient,
  membershipId: string,
  roleId: string,
): Promise<void> {
  await tx.membershipRole.upsert({
    where: { membershipId_roleId: { membershipId, roleId } },
    update: {},
    create: { membershipId, roleId },
  });
}
