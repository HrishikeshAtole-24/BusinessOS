import { z } from 'zod';
import { dateOnlySchema } from './people.js';

/**
 * Projects and tasks (report Section 3.1, modules "Projects" and "Tasks").
 */

export const PROJECT_STATUSES = [
  'PLANNING',
  'ACTIVE',
  'ON_HOLD',
  'COMPLETED',
  'CANCELLED',
] as const;
export const TASK_STATUSES = ['TODO', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW', 'DONE'] as const;
export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type Priority = (typeof PRIORITIES)[number];

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/** Task-key prefix, e.g. "VEP" giving VEP-1, VEP-2. */
export const projectKeySchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(2, 'Use at least 2 characters')
  .max(10)
  .regex(/^[A-Z][A-Z0-9]*$/, 'Start with a letter; use letters and numbers only');

/**
 * Money as a decimal string, never a JS number.
 *
 * Section 28.2: "Money: amount + currency, never a floating-point business
 * value." `0.1 + 0.2 !== 0.3` in IEEE 754, and JSON has no decimal type — so
 * the amount crosses the wire as a string and lands in a PostgreSQL NUMERIC.
 */
export const moneySchema = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, 'Use a number with at most 2 decimal places');

export const createProjectSchema = z.object({
  name: z.string().trim().min(2, 'Use at least 2 characters').max(160),
  key: projectKeySchema,
  description: z.string().trim().max(1000).optional(),
  priority: z.enum(PRIORITIES).default('MEDIUM'),
  startDate: dateOnlySchema.optional(),
  dueDate: dateOnlySchema.optional(),
  budgetAmount: moneySchema.optional(),
  budgetCurrency: z.string().trim().toUpperCase().length(3).optional(),
  ownerId: z.string().uuid().nullable().optional(),
});
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  startDate: dateOnlySchema.nullable().optional(),
  dueDate: dateOnlySchema.nullable().optional(),
  budgetAmount: moneySchema.nullable().optional(),
  budgetCurrency: z.string().trim().toUpperCase().length(3).nullable().optional(),
  ownerId: z.string().uuid().nullable().optional(),
  version: z.number().int().min(0),
});
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

export const projectQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
});

export const addProjectMemberSchema = z.object({
  employeeId: z.string().uuid(),
  role: z.string().trim().min(2).max(60).default('Contributor'),
});

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export const createTaskSchema = z.object({
  title: z.string().trim().min(2, 'Use at least 2 characters').max(240),
  description: z.string().trim().max(4000).optional(),
  priority: z.enum(PRIORITIES).default('MEDIUM'),
  assigneeId: z.string().uuid().nullable().optional(),
  dueDate: dateOnlySchema.optional(),
  /** Hours. Used as the weight when computing the critical path. */
  estimateHours: z.coerce.number().min(0).max(9999).optional(),
  /** Sub-task parent. A tree, separate from the dependency DAG. */
  parentId: z.string().uuid().nullable().optional(),
  /** Task ids that must finish first. Rejected if any would create a cycle. */
  dependsOn: z.array(z.string().uuid()).max(50).optional(),
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const updateTaskSchema = z.object({
  title: z.string().trim().min(2).max(240).optional(),
  description: z.string().trim().max(4000).nullable().optional(),
  /** Validated against the Section 8.1 transition table, not just the enum. */
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  dueDate: dateOnlySchema.nullable().optional(),
  estimateHours: z.coerce.number().min(0).max(9999).nullable().optional(),
  actualHours: z.coerce.number().min(0).max(9999).nullable().optional(),
  version: z.number().int().min(0),
});
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export const taskQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  projectId: z.string().uuid().optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  assigneeId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
});

export const addDependencySchema = z.object({
  /** The task that must finish first. */
  predecessorId: z.string().uuid(),
});

export const createCommentSchema = z.object({
  body: z.string().trim().min(1, 'Say something').max(4000),
});

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface TaskSummary {
  id: string;
  key: string;
  title: string;
  status: TaskStatus;
  priority: Priority;
  dueDate: string | null;
  estimateHours: number | null;
  assignee: { id: string; firstName: string; lastName: string } | null;
  blockedByCount: number;
  blocksCount: number;
}

export interface ProjectSummary {
  id: string;
  name: string;
  key: string;
  status: ProjectStatus;
  priority: Priority;
  startDate: string | null;
  dueDate: string | null;
  budgetAmount: string | null;
  budgetCurrency: string | null;
  owner: { id: string; firstName: string; lastName: string } | null;
  taskCount: number;
  doneCount: number;
  memberCount: number;
}

/**
 * The output of the graph algorithms, for the project board.
 *
 * `schedule` is null when the dependency graph is cyclic — which the API
 * prevents on write, so a non-null value here is also a runtime assertion that
 * the stored graph is still acyclic.
 */
export interface ProjectSchedule {
  /** Kahn's order: a valid sequence to execute tasks in. */
  order: string[] | null;
  /** Tasks in a cycle, if the stored graph is somehow corrupt. */
  cyclic: string[];
  /** Longest weighted chain — the tasks that determine the end date. */
  criticalPath: string[];
  criticalPathHours: number;
  /** Not started, and every predecessor complete. */
  ready: string[];
  /** Waiting on an incomplete predecessor. */
  blocked: Array<{ taskId: string; waitingOn: string[] }>;
}
