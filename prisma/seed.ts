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
  designation: string;
  /** Role key of this person's manager, for the reporting chain. */
  reportsTo?: SystemRoleKey;
}

const DEMO_USERS: DemoUser[] = [
  {
    email: 'owner@businessos.dev',
    name: 'Hrishikesh Atole',
    role: 'owner',
    designation: 'Founder',
  },
  {
    email: 'hr@businessos.dev',
    name: 'Priya Sharma',
    role: 'hr',
    designation: 'Head of People',
    reportsTo: 'owner',
  },
  {
    email: 'manager@businessos.dev',
    name: 'Rahul Verma',
    role: 'manager',
    designation: 'Engineering Manager',
    reportsTo: 'owner',
  },
  {
    email: 'finance@businessos.dev',
    name: 'Anjali Nair',
    role: 'finance',
    designation: 'Finance Lead',
    reportsTo: 'owner',
  },
  {
    email: 'employee@businessos.dev',
    name: 'Karan Mehta',
    role: 'employee',
    designation: 'Software Engineer',
    reportsTo: 'manager',
  },
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
): Promise<string> {
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

  await seedDemoEmployees(prisma, organization.id);

  return organization.id;
}

/**
 * Employee records for the demo accounts, with a reporting chain.
 *
 * Without these the approval engine has nothing to resolve: a MANAGER step
 * needs `Employee.managerId`, and a user with no employee record cannot file a
 * claim at all. Created in two passes because a manager must exist before
 * anyone can point at them.
 */
async function seedDemoEmployees(prisma: PrismaClient, organizationId: string): Promise<void> {
  const department = await prisma.department.upsert({
    where: { organizationId_code: { organizationId, code: 'OPS' } },
    update: {},
    create: { organizationId, name: 'Operations', code: 'OPS' },
    select: { id: true },
  });

  const byRole = new Map<SystemRoleKey, string>();

  // Pass 1: create everyone without a manager.
  for (const demo of DEMO_USERS) {
    const user = await prisma.user.findUniqueOrThrow({
      where: { email: demo.email },
      select: { id: true },
    });
    const [firstName = demo.name, lastName = ''] = demo.name.split(' ');

    const employee = await prisma.employee.upsert({
      where: { organizationId_workEmail: { organizationId, workEmail: demo.email } },
      update: { userId: user.id, designation: demo.designation },
      create: {
        organizationId,
        userId: user.id,
        employeeCode: `OPS-${demo.role.slice(0, 3).toUpperCase()}`,
        firstName,
        lastName,
        workEmail: demo.email,
        designation: demo.designation,
        departmentId: department.id,
        joinedOn: new Date('2024-01-15'),
      },
      select: { id: true },
    });
    byRole.set(demo.role, employee.id);
  }

  // Pass 2: wire the reporting lines now that every target exists.
  for (const demo of DEMO_USERS) {
    if (!demo.reportsTo) continue;
    await prisma.employee.update({
      where: { id: byRole.get(demo.role)! },
      data: { managerId: byRole.get(demo.reportsTo)! },
    });
  }

  // The owner heads Operations, which is what a DEPARTMENT_HEAD step resolves.
  await prisma.department.update({
    where: { id: department.id },
    data: { headId: byRole.get('owner')! },
  });

  console.log(`    employee records: ${DEMO_USERS.length} (Karan -> Rahul -> Hrishikesh)`);
}

// ---------------------------------------------------------------------------
// Finance and leave configuration
// ---------------------------------------------------------------------------

/**
 * Seed the approval policies, expense categories and leave types.
 *
 * The expense policy is the report's own worked example (Section 13.2):
 * Manager, then Finance, then a Director step that only applies above 50,000.
 * Leave stops at the manager, because escalating a day off to finance would be
 * absurd — which is the point of policies being per-entity-type.
 */
async function seedFinanceAndLeave(prisma: PrismaClient, organizationId: string): Promise<void> {
  const categories = [
    { code: 'TRAVEL', name: 'Travel', receiptRequiredAbove: '2000.00' },
    { code: 'FOOD', name: 'Food', receiptRequiredAbove: '1000.00' },
    { code: 'HOTEL', name: 'Hotel', receiptRequiredAbove: '0.00' },
    { code: 'SOFTWARE', name: 'Software', receiptRequiredAbove: '5000.00' },
    { code: 'EQUIPMENT', name: 'Equipment', receiptRequiredAbove: '0.00' },
    { code: 'MISC', name: 'Miscellaneous', receiptRequiredAbove: null },
  ];
  for (const category of categories) {
    await prisma.expenseCategory.upsert({
      where: { organizationId_code: { organizationId, code: category.code } },
      update: { name: category.name },
      create: { organizationId, ...category },
    });
  }
  console.log(`    expense categories: ${categories.length}`);

  const leaveTypes = [
    { code: 'CL', name: 'Casual Leave', annualQuota: 12, isPaid: true, colour: '#4d84f5' },
    { code: 'SL', name: 'Sick Leave', annualQuota: 8, isPaid: true, colour: '#f6b73c' },
    { code: 'EL', name: 'Earned Leave', annualQuota: 18, isPaid: true, colour: '#3ecf8e' },
    { code: 'LWP', name: 'Leave Without Pay', annualQuota: 0, isPaid: false, colour: '#6b7684' },
    { code: 'WFH', name: 'Work From Home', annualQuota: 0, isPaid: false, colour: '#8fb3fa' },
  ];
  for (const type of leaveTypes) {
    await prisma.leaveType.upsert({
      where: { organizationId_code: { organizationId, code: type.code } },
      update: { name: type.name, annualQuota: type.annualQuota },
      create: { organizationId, ...type },
    });
  }
  console.log(`    leave types: ${leaveTypes.length}`);

  // Replace any existing policy so re-seeding is idempotent.
  await prisma.approvalPolicy.deleteMany({ where: { organizationId } });

  await prisma.approvalPolicy.create({
    data: {
      organizationId,
      entityType: 'EXPENSE',
      name: 'Standard expense approval',
      description: 'Manager, then Finance. Director sign-off above 50,000.',
      steps: {
        create: [
          { sequence: 1, name: 'Manager', approverType: 'MANAGER' },
          { sequence: 2, name: 'Finance', approverType: 'ROLE', approverRoleKey: 'finance' },
          {
            sequence: 3,
            name: 'Director',
            approverType: 'ROLE',
            approverRoleKey: 'owner',
            minAmount: '50000.00',
          },
        ],
      },
    },
  });

  await prisma.approvalPolicy.create({
    data: {
      organizationId,
      entityType: 'LEAVE',
      name: 'Standard leave approval',
      description: 'Manager only. HR sees everything but does not gate each request.',
      steps: {
        create: [{ sequence: 1, name: 'Manager', approverType: 'MANAGER' }],
      },
    },
  });
  console.log('    approval policies: 2 (expense 3 steps, leave 1 step)');
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
    const organizationId = await seedDemoOrganization(prisma, permissionIds);

    console.log('\nfinance and leave');
    await seedFinanceAndLeave(prisma, organizationId);

    console.log(`\nDone. Sign in with any address above / ${DEMO_PASSWORD}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('\nSeed failed:', error);
  process.exit(1);
});
