import { z } from 'zod';
import { emailSchema, nameSchema } from './auth.js';

/**
 * People module contracts — departments and employees (report Section 3.1).
 */

export const EMPLOYMENT_TYPES = [
  'FULL_TIME',
  'PART_TIME',
  'CONTRACT',
  'INTERN',
  'CONSULTANT',
] as const;

export const EMPLOYMENT_STATUSES = ['ACTIVE', 'ON_NOTICE', 'ON_LEAVE', 'EXITED'] as const;

export const WORK_MODES = ['OFFICE', 'REMOTE', 'HYBRID'] as const;

export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];
export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];
export type WorkMode = (typeof WORK_MODES)[number];

// ---------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------

/** Uppercase short code, e.g. "ENG". Normalised so "eng" and "ENG" collide. */
export const departmentCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(2, 'Use at least 2 characters')
  .max(16)
  .regex(/^[A-Z0-9-]+$/, 'Use letters, numbers and hyphens only');

export const createDepartmentSchema = z.object({
  name: z.string().trim().min(2, 'Use at least 2 characters').max(120),
  code: departmentCodeSchema,
  description: z.string().trim().max(255).optional(),
  /** Null or omitted creates a top-level department. */
  parentId: z.string().uuid().nullable().optional(),
  headId: z.string().uuid().nullable().optional(),
});
export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>;

export const updateDepartmentSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(255).nullable().optional(),
  /**
   * Re-parenting. The service rejects any move that would make a department its
   * own ancestor — a cycle the database cannot prevent on its own.
   */
  parentId: z.string().uuid().nullable().optional(),
  headId: z.string().uuid().nullable().optional(),
});
export type UpdateDepartmentInput = z.infer<typeof updateDepartmentSchema>;

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD`. Dates without a time, so no timezone can shift them a day. */
export const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Not a real date');

export const employeeCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(2)
  .max(24)
  .regex(/^[A-Z0-9-]+$/, 'Use letters, numbers and hyphens only');

export const createEmployeeSchema = z.object({
  firstName: nameSchema,
  lastName: nameSchema,
  workEmail: emailSchema,
  personalEmail: emailSchema.optional(),
  phone: z.string().trim().min(6).max(24).optional(),

  /** Omitted means the server derives one from the department code. */
  employeeCode: employeeCodeSchema.optional(),
  designation: z.string().trim().min(2, 'Required').max(120),
  employmentType: z.enum(EMPLOYMENT_TYPES).default('FULL_TIME'),
  workMode: z.enum(WORK_MODES).default('OFFICE'),
  location: z.string().trim().max(120).optional(),

  joinedOn: dateOnlySchema,
  departmentId: z.string().uuid().nullable().optional(),
  managerId: z.string().uuid().nullable().optional(),
  /** Link to an existing login, if this person already has an account. */
  userId: z.string().uuid().nullable().optional(),
});
export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;

export const updateEmployeeSchema = z.object({
  firstName: nameSchema.optional(),
  lastName: nameSchema.optional(),
  personalEmail: emailSchema.nullable().optional(),
  phone: z.string().trim().min(6).max(24).nullable().optional(),
  designation: z.string().trim().min(2).max(120).optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
  status: z.enum(EMPLOYMENT_STATUSES).optional(),
  workMode: z.enum(WORK_MODES).optional(),
  location: z.string().trim().max(120).nullable().optional(),
  departmentId: z.string().uuid().nullable().optional(),
  /** Rejected when it would create a reporting cycle. */
  managerId: z.string().uuid().nullable().optional(),
  exitedOn: dateOnlySchema.nullable().optional(),

  /** Optimistic concurrency (Section 11.2). */
  version: z.number().int().min(0),
});
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;

/** Directory filters. Cursor pagination per Section 16.1. */
export const employeeQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  departmentId: z.string().uuid().optional(),
  managerId: z.string().uuid().optional(),
  status: z.enum(EMPLOYMENT_STATUSES).optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
});
export type EmployeeQuery = z.infer<typeof employeeQuerySchema>;

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface EmployeeSummary {
  id: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  workEmail: string;
  designation: string;
  employmentType: EmploymentType;
  status: EmploymentStatus;
  workMode: WorkMode;
  location: string | null;
  joinedOn: string;
  department: { id: string; name: string; code: string } | null;
  manager: { id: string; firstName: string; lastName: string } | null;
}

export interface DepartmentNode {
  id: string;
  name: string;
  code: string;
  description: string | null;
  parentId: string | null;
  headcount: number;
  /** Assigned by traversal, not stored — see `buildTree`. */
  depth: number;
  children: DepartmentNode[];
}
