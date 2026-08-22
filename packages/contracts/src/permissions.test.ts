import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSION_KEYS,
  PERMISSION_LIST,
  SYSTEM_ROLES,
  expandPermissions,
  isPermissionKey,
  permissionsForSystemRole,
} from './permissions.js';

describe('permission catalogue', () => {
  it('has no duplicate keys', () => {
    // A duplicate would silently make one description unreachable and, worse,
    // break the seed's unique constraint at insert time rather than here.
    expect(new Set(ALL_PERMISSION_KEYS).size).toBe(ALL_PERMISSION_KEYS.length);
  });

  it('uses <module>.<action> keys whose prefix matches the declared module', () => {
    for (const { key, module } of PERMISSION_LIST) {
      expect(key, `${key} should be <module>.<action>`).toMatch(/^[a-z_]+\.[a-z_]+$/);
      expect(key.split('.')[0], `${key} declares module "${module}"`).toBe(module);
    }
  });
});

describe('expandPermissions', () => {
  it('expands the global wildcard to every permission', () => {
    expect(expandPermissions(['*']).size).toBe(ALL_PERMISSION_KEYS.length);
  });

  it('expands a module wildcard to exactly that module', () => {
    const resolved = expandPermissions(['leave.*']);
    expect(resolved.size).toBeGreaterThan(0);
    for (const key of resolved) expect(key.startsWith('leave.')).toBe(true);

    const expected = PERMISSION_LIST.filter((p) => p.module === 'leave').length;
    expect(resolved.size).toBe(expected);
  });

  it('passes concrete keys through and de-duplicates overlapping patterns', () => {
    const resolved = expandPermissions(['leave.approve', 'leave.*', 'leave.approve']);
    expect(resolved.has('leave.approve')).toBe(true);
    expect(resolved.size).toBe(PERMISSION_LIST.filter((p) => p.module === 'leave').length);
  });

  it('throws on an unknown key rather than granting nothing', () => {
    // The failure mode this guards against: a typo in a role definition would
    // otherwise produce a role that is quietly missing a permission — an
    // authorization bug that only shows up when a user reports being blocked.
    expect(() => expandPermissions(['leave.aprove' as never])).toThrow(/Unknown permission key/);
  });

  it('throws on a wildcard matching no module', () => {
    expect(() => expandPermissions(['payroll.*' as never])).toThrow(/matches no module/);
  });
});

describe('system roles', () => {
  it('every grant resolves', () => {
    for (const role of SYSTEM_ROLES) {
      expect(() => permissionsForSystemRole(role.key), `role "${role.key}"`).not.toThrow();
    }
  });

  it('owner holds every permission', () => {
    expect(permissionsForSystemRole('owner').size).toBe(ALL_PERMISSION_KEYS.length);
  });

  it('only owner may archive the organization', () => {
    for (const role of SYSTEM_ROLES) {
      const holds = permissionsForSystemRole(role.key).has('organization.delete');
      expect(holds, `role "${role.key}"`).toBe(role.key === 'owner');
    }
  });

  it('employee is self-service only: no permission that reads other people', () => {
    // The `*_self` split is what makes least privilege workable here. If an
    // ordinary employee ever gains a bare `*.read` over someone else's leave,
    // attendance or expenses, that is a privilege escalation.
    const employee = permissionsForSystemRole('employee');
    for (const key of [
      'leave.read',
      'attendance.read',
      'expense.read',
      'timesheet.read',
    ] as const) {
      expect(employee.has(key), `employee must not hold ${key}`).toBe(false);
    }
    expect(employee.has('leave.read_self')).toBe(true);
    expect(employee.has('expense.read_self')).toBe(true);
  });

  it('employee cannot approve anything', () => {
    const employee = permissionsForSystemRole('employee');
    for (const key of ALL_PERMISSION_KEYS) {
      if (key.endsWith('.approve')) {
        expect(employee.has(key), `employee must not hold ${key}`).toBe(false);
      }
    }
  });

  it('finance owns the expense lifecycle including reimbursement', () => {
    const finance = permissionsForSystemRole('finance');
    expect(finance.has('expense.approve')).toBe(true);
    expect(finance.has('expense.reimburse')).toBe(true);
  });

  it('manager can approve leave but cannot rewrite leave policy', () => {
    const manager = permissionsForSystemRole('manager');
    expect(manager.has('leave.approve')).toBe(true);
    expect(manager.has('leave.manage_policy')).toBe(false);
  });

  it('every role can read its own organization', () => {
    for (const role of SYSTEM_ROLES) {
      expect(permissionsForSystemRole(role.key).has('organization.read'), role.key).toBe(true);
    }
  });
});

describe('isPermissionKey', () => {
  it('accepts catalogued keys and rejects everything else', () => {
    expect(isPermissionKey('expense.approve')).toBe(true);
    expect(isPermissionKey('expense.*')).toBe(false);
    expect(isPermissionKey('')).toBe(false);
    expect(isPermissionKey('__proto__')).toBe(false);
  });
});
