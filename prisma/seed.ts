import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import {
  PERMISSION_LIST,
  SYSTEM_ROLES,
  permissionsForSystemRole,
  type SystemRoleKey,
} from '@businessos/contracts';
import { createPrismaClient, type PrismaClient } from '@businessos/database';
import { hashPassword } from '@businessos/domain';

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../.env'),
  override: false,
  quiet: true,
});

/**
 * Database seed.
 *
 * Idempotent by construction — every write is an upsert keyed on a natural
 * unique constraint. A seed that can only run once is a seed nobody runs, and
 * this one has to be re-run every time a permission is added to the catalogue.
 */

// ---------------------------------------------------------------------------
// Global permission catalogue
// ---------------------------------------------------------------------------

/**
 * Permissions are global, not tenant-scoped: `expense.approve` means the same
 * thing in every organization. Roles are per-tenant and compose from this fixed
 * vocabulary (Section 18.3).
 */
async function seedPermissions(prisma: PrismaClient): Promise<Map<string, string>> {
  await prisma.$transaction(
    PERMISSION_LIST.map((permission) =>
      prisma.permission.upsert({
        where: { key: permission.key },
        // Descriptions are editable; the key is the contract.
        update: { module: permission.module, description: permission.description },
        create: {
          key: permission.key,
          module: permission.module,
          description: permission.description,
        },
      }),
    ),
  );

  const rows = await prisma.permission.findMany({ select: { id: true, key: true } });
  console.log(`  permissions: ${rows.length}`);
  return new Map(rows.map((r) => [r.key, r.id]));
}

// ---------------------------------------------------------------------------
// Per-organization system roles
// ---------------------------------------------------------------------------

/**
 * Create (or reconcile) the six system roles for one organization.
 *
 * This runs for every new organization, so it will move into the org-creation
 * use case once that endpoint exists. It lives here for now because the seed is
 * currently its only caller.
 *
 * Note the reconcile step: grants are recomputed and stale ones deleted, so
 * adding a permission to the catalogue and re-running the seed actually updates
 * existing organizations rather than silently leaving them behind.
 */
async function seedSystemRoles(
  prisma: PrismaClient,
  organizationId: string,
  permissionIds: Map<string, string>,
): Promise<Map<SystemRoleKey, string>> {
  const roleIds = new Map<SystemRoleKey, string>();

  for (const definition of SYSTEM_ROLES) {
    const role = await prisma.role.upsert({
      where: {
        organizationId_key: { organizationId, key: definition.key },
      },
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

    // Wildcards are expanded here, never stored. A `leave.*` row in
    // role_permissions would silently widen this role the next time a
    // permission was added to the catalogue.
    const granted = permissionsForSystemRole(definition.key);
    const grantedIds = [...granted].map((key) => {
      const id = permissionIds.get(key);
      if (!id) throw new Error(`Permission "${key}" is not in the database. Seed it first.`);
      return id;
    });

    await prisma.$transaction([
      // Revoke anything no longer granted, so the role tracks the catalogue.
      prisma.rolePermission.deleteMany({
        where: { roleId: role.id, permissionId: { notIn: grantedIds } },
      }),
      prisma.rolePermission.createMany({
        data: grantedIds.map((permissionId) => ({ roleId: role.id, permissionId })),
        skipDuplicates: true,
      }),
    ]);

    console.log(`    ${definition.key.padEnd(9)} ${granted.size} permissions`);
  }

  return roleIds;
}

// ---------------------------------------------------------------------------
// Demo organization
// ---------------------------------------------------------------------------

interface DemoUser {
  email: string;
  name: string;
  role: SystemRoleKey;
}

const DEMO_USERS: DemoUser[] = [
  { email: 'owner@businessos.dev', name: 'Hrishikesh Atole', role: 'owner' },
  { email: 'hr@businessos.dev', name: 'Priya Sharma', role: 'hr' },
  { email: 'manager@businessos.dev', name: 'Rahul Verma', role: 'manager' },
  { email: 'finance@businessos.dev', name: 'Anjali Nair', role: 'finance' },
  { email: 'employee@businessos.dev', name: 'Karan Mehta', role: 'employee' },
];

/**
 * One account per system role, so authorization can be exercised by hand from
 * day one: log in as the employee and confirm the approvals page refuses you.
 * A seed with only an admin account hides every bug that matters here.
 */
const DEMO_PASSWORD = process.env['SEED_PASSWORD'] ?? 'BusinessOS!2026';

async function seedDemoOrganization(
  prisma: PrismaClient,
  permissionIds: Map<string, string>,
): Promise<void> {
  const organization = await prisma.organization.upsert({
    where: { slug: 'demo' },
    update: {},
    create: {
      name: 'Demo Company',
      slug: 'demo',
      timezone: 'Asia/Kolkata',
      currency: 'INR',
    },
    select: { id: true, name: true },
  });
  console.log(`  organization: ${organization.name}`);

  const roleIds = await seedSystemRoles(prisma, organization.id, permissionIds);

  // Hash once: Argon2id is deliberately slow, and these all share a password.
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  for (const demo of DEMO_USERS) {
    const user = await prisma.user.upsert({
      where: { email: demo.email },
      update: {},
      create: {
        email: demo.email,
        name: demo.name,
        passwordHash,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });

    const membership = await prisma.membership.upsert({
      where: {
        organizationId_userId: { organizationId: organization.id, userId: user.id },
      },
      update: { status: 'ACTIVE' },
      create: { organizationId: organization.id, userId: user.id, status: 'ACTIVE' },
      select: { id: true },
    });

    const roleId = roleIds.get(demo.role);
    if (!roleId) throw new Error(`System role "${demo.role}" was not created.`);

    await prisma.membershipRole.upsert({
      where: { membershipId_roleId: { membershipId: membership.id, roleId } },
      update: {},
      create: { membershipId: membership.id, roleId },
    });

    console.log(`    ${demo.role.padEnd(9)} ${demo.email}`);
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) throw new Error('DATABASE_URL is not set. Copy .env.example to .env.');

  const prisma = createPrismaClient({ databaseUrl });

  try {
    console.log('\nSeeding BusinessOS\n');

    console.log('permission catalogue');
    const permissionIds = await seedPermissions(prisma);

    console.log('\ndemo organization');
    await seedDemoOrganization(prisma, permissionIds);

    console.log(`\nDone. Sign in with any address above / ${DEMO_PASSWORD}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('\nSeed failed:', error);
  process.exit(1);
});
