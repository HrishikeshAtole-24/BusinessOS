/**
 * The permission catalogue (report Section 18.3).
 *
 * Two rules this file exists to enforce:
 *
 *  1. **Business logic keys off permissions, never role names.** A check reads
 *     `can('expense.approve')`, never `role === 'FINANCE'`. Roles are a way to
 *     bundle permissions for humans to administer; they are not an authorization
 *     primitive. The moment code branches on a role name, adding a seventh role
 *     means editing every such branch.
 *
 *  2. **Permission keys are global.** `expense.approve` means the same thing in
 *     every tenant, which is why the `permissions` table is not tenant-scoped
 *     while `roles` is. Tenants compose their own roles from a fixed vocabulary.
 */

/** `<module>.<action>` — the wire format stored in the `permissions` table. */
export type PermissionKey = (typeof PERMISSION_LIST)[number]['key'];

export type PermissionModule = (typeof PERMISSION_LIST)[number]['module'];

export interface PermissionDefinition {
  readonly key: string;
  readonly module: string;
  readonly description: string;
}

/**
 * Source of truth for `prisma/seed.ts`. Adding an entry here and re-seeding is
 * the only supported way to introduce a permission.
 *
 * Scoped to the modules that exist or are imminent. Section 3.1 lists later
 * modules (documents, workflow automation, AI); their permissions land with them
 * rather than being speculated on now.
 */
export const PERMISSION_LIST = [
  // --- Organization -------------------------------------------------------
  {
    key: 'organization.read',
    module: 'organization',
    description: 'View organization profile and settings',
  },
  {
    key: 'organization.update',
    module: 'organization',
    description: 'Edit organization profile and settings',
  },
  { key: 'organization.delete', module: 'organization', description: 'Archive the organization' },

  // --- Members and access -------------------------------------------------
  { key: 'member.read', module: 'member', description: 'View the member directory' },
  { key: 'member.invite', module: 'member', description: 'Invite people to the organization' },
  { key: 'member.update', module: 'member', description: 'Change a member status' },
  { key: 'member.remove', module: 'member', description: 'Remove a member from the organization' },
  { key: 'role.read', module: 'role', description: 'View roles and their permissions' },
  { key: 'role.manage', module: 'role', description: 'Create, edit and delete custom roles' },
  { key: 'role.assign', module: 'role', description: 'Assign roles to members' },

  // --- People -------------------------------------------------------------
  { key: 'employee.read', module: 'employee', description: 'View employee profiles' },
  { key: 'employee.read_self', module: 'employee', description: 'View own employee profile' },
  { key: 'employee.create', module: 'employee', description: 'Create employee records' },
  { key: 'employee.update', module: 'employee', description: 'Edit employee records' },
  { key: 'employee.delete', module: 'employee', description: 'Deactivate employee records' },
  { key: 'department.read', module: 'department', description: 'View departments and teams' },
  {
    key: 'department.manage',
    module: 'department',
    description: 'Create and edit departments and teams',
  },

  // --- Attendance ---------------------------------------------------------
  { key: 'attendance.read', module: 'attendance', description: 'View attendance for others' },
  { key: 'attendance.read_self', module: 'attendance', description: 'View own attendance' },
  { key: 'attendance.record', module: 'attendance', description: 'Check in and out' },
  {
    key: 'attendance.correct',
    module: 'attendance',
    description: 'Raise an auditable attendance correction',
  },

  // --- Leave --------------------------------------------------------------
  { key: 'leave.read', module: 'leave', description: 'View leave requests for others' },
  { key: 'leave.read_self', module: 'leave', description: 'View own leave and balances' },
  { key: 'leave.request', module: 'leave', description: 'Request leave' },
  { key: 'leave.approve', module: 'leave', description: 'Approve or reject leave requests' },
  {
    key: 'leave.manage_policy',
    module: 'leave',
    description: 'Configure leave types and policies',
  },

  // --- Work ---------------------------------------------------------------
  { key: 'project.read', module: 'project', description: 'View projects' },
  { key: 'project.create', module: 'project', description: 'Create projects' },
  { key: 'project.manage', module: 'project', description: 'Edit projects, members and budgets' },
  { key: 'task.read', module: 'task', description: 'View tasks' },
  { key: 'task.create', module: 'task', description: 'Create tasks' },
  { key: 'task.update', module: 'task', description: 'Edit tasks and change status' },
  { key: 'task.assign', module: 'task', description: 'Assign tasks to people' },
  { key: 'timesheet.read', module: 'timesheet', description: 'View timesheets for others' },
  { key: 'timesheet.read_self', module: 'timesheet', description: 'View own timesheets' },
  { key: 'timesheet.log', module: 'timesheet', description: 'Log time against tasks' },
  { key: 'timesheet.approve', module: 'timesheet', description: 'Approve submitted timesheets' },

  // --- Finance ------------------------------------------------------------
  { key: 'expense.read', module: 'expense', description: 'View expenses for others' },
  { key: 'expense.read_self', module: 'expense', description: 'View own expenses' },
  { key: 'expense.create', module: 'expense', description: 'Submit expense claims' },
  { key: 'expense.approve', module: 'expense', description: 'Approve or reject expense claims' },
  { key: 'expense.reimburse', module: 'expense', description: 'Mark an expense reimbursed' },

  // --- Platform -----------------------------------------------------------
  { key: 'approval.read', module: 'approval', description: 'View approval requests' },
  { key: 'approval.act', module: 'approval', description: 'Act on an assigned approval step' },
  { key: 'audit.read', module: 'audit', description: 'View the organization audit trail' },
  { key: 'analytics.read', module: 'analytics', description: 'View company-wide analytics' },
] as const satisfies readonly PermissionDefinition[];

/**
 * Every permission key, for validation and seeding.
 *
 * No cast needed: `as const satisfies` above already narrows each `key` to its
 * literal type, so the mapped array is `PermissionKey[]` on its own.
 */
export const ALL_PERMISSION_KEYS: readonly PermissionKey[] = PERMISSION_LIST.map((p) => p.key);

const PERMISSION_KEY_SET: ReadonlySet<string> = new Set(ALL_PERMISSION_KEYS);

export function isPermissionKey(value: string): value is PermissionKey {
  return PERMISSION_KEY_SET.has(value);
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/**
 * A grant is either an exact key (`leave.approve`), a module wildcard
 * (`leave.*`), or the global wildcard (`*`).
 *
 * Wildcards exist for *authoring* role definitions only. They are expanded to
 * concrete keys before storage, so `role_permissions` always holds explicit
 * rows. That matters: a wildcard stored in the database would silently widen
 * every existing role the next time someone adds a permission to this file.
 */
export type PermissionPattern = PermissionKey | `${PermissionModule}.*` | '*';

/**
 * Expand grant patterns into the concrete permission set.
 *
 * Section 26.1 calls for effective permissions to be compiled into a `Set` once
 * per request; this is that compilation step. Membership checks are then O(1)
 * rather than a scan per check.
 */
export function expandPermissions(
  patterns: readonly PermissionPattern[],
): ReadonlySet<PermissionKey> {
  const resolved = new Set<PermissionKey>();

  for (const pattern of patterns) {
    if (pattern === '*') {
      for (const key of ALL_PERMISSION_KEYS) resolved.add(key);
      continue;
    }

    if (pattern.endsWith('.*')) {
      const module = pattern.slice(0, -2);
      const matched = PERMISSION_LIST.filter((d) => d.module === module);
      if (matched.length === 0) {
        throw new Error(`Permission pattern "${pattern}" matches no module.`);
      }
      for (const definition of matched) resolved.add(definition.key);
      continue;
    }

    // Not a wildcard, so it must be a concrete key. Verifying rather than
    // casting means a typo in a role definition throws at startup instead of
    // silently granting nothing — a role that quietly lost a permission is
    // exactly the kind of authorization bug that surfaces late and badly.
    if (!isPermissionKey(pattern)) {
      throw new Error(`Unknown permission key: "${pattern}"`);
    }
    resolved.add(pattern);
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// System roles
// ---------------------------------------------------------------------------

export const SYSTEM_ROLE_KEYS = ['owner', 'admin', 'hr', 'manager', 'finance', 'employee'] as const;
export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

export interface SystemRoleDefinition {
  readonly key: SystemRoleKey;
  readonly name: string;
  readonly description: string;
  readonly grants: readonly PermissionPattern[];
}

/**
 * Seeded into every new organization and flagged `isSystem`, so the API refuses
 * to rename or delete them. Tenants add custom roles alongside these.
 *
 * The `*_self` permissions are what make least privilege workable: an ordinary
 * employee can see their own leave balance without being able to see anyone
 * else's. Without that split, `leave.read` would have to be granted to everyone
 * and would then mean nothing.
 */
export const SYSTEM_ROLES = [
  {
    key: 'owner',
    name: 'Owner',
    description: 'Full control, including archiving the organization.',
    grants: ['*'],
  },
  {
    key: 'admin',
    name: 'Admin',
    description: 'Full control except destroying the organization.',
    grants: [
      'organization.read',
      'organization.update',
      'member.*',
      'role.*',
      'employee.*',
      'department.*',
      'attendance.*',
      'leave.*',
      'project.*',
      'task.*',
      'timesheet.*',
      'expense.*',
      'approval.*',
      'audit.read',
      'analytics.read',
    ],
  },
  {
    key: 'hr',
    name: 'HR',
    description: 'Owns people, attendance and leave.',
    grants: [
      'organization.read',
      'member.read',
      'member.invite',
      'employee.*',
      'department.*',
      'attendance.*',
      'leave.*',
      'approval.read',
      'approval.act',
      'audit.read',
      'analytics.read',
    ],
  },
  {
    key: 'manager',
    name: 'Manager',
    description: 'Runs a team and its work; approves what the team submits.',
    grants: [
      'organization.read',
      'member.read',
      'employee.read',
      'employee.read_self',
      'department.read',
      'attendance.read',
      'attendance.read_self',
      'attendance.record',
      'leave.read',
      'leave.read_self',
      'leave.request',
      'leave.approve',
      'project.*',
      'task.*',
      'timesheet.read',
      'timesheet.read_self',
      'timesheet.log',
      'timesheet.approve',
      'expense.read',
      'expense.read_self',
      'expense.create',
      'expense.approve',
      'approval.read',
      'approval.act',
      'analytics.read',
    ],
  },
  {
    key: 'finance',
    name: 'Finance',
    description: 'Owns expenses and reimbursement.',
    grants: [
      'organization.read',
      'member.read',
      'employee.read',
      'employee.read_self',
      'department.read',
      'attendance.read_self',
      'leave.read_self',
      'leave.request',
      'project.read',
      'timesheet.read',
      'timesheet.read_self',
      'timesheet.log',
      'expense.*',
      'approval.read',
      'approval.act',
      'audit.read',
      'analytics.read',
    ],
  },
  {
    key: 'employee',
    name: 'Employee',
    description: 'Self-service only.',
    grants: [
      'organization.read',
      'member.read',
      'employee.read_self',
      'department.read',
      'attendance.read_self',
      'attendance.record',
      'leave.read_self',
      'leave.request',
      'project.read',
      'task.read',
      'task.update',
      'timesheet.read_self',
      'timesheet.log',
      'expense.read_self',
      'expense.create',
      'approval.read',
    ],
  },
] as const satisfies readonly SystemRoleDefinition[];

/** Concrete permission keys granted by a system role. */
export function permissionsForSystemRole(key: SystemRoleKey): ReadonlySet<PermissionKey> {
  const role = SYSTEM_ROLES.find((r) => r.key === key);
  if (!role) throw new Error(`Unknown system role: ${key}`);
  return expandPermissions(role.grants);
}
