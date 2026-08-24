import { z } from 'zod';
import { dateOnlySchema } from './people.js';
import { moneySchema } from './work.js';

/**
 * Expenses, leave, and the approval engine that serves both
 * (report Sections 3.1 and 13).
 */

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export const APPROVAL_ENTITY_TYPES = ['EXPENSE', 'LEAVE'] as const;
export const APPROVER_TYPES = ['MANAGER', 'DEPARTMENT_HEAD', 'ROLE', 'SPECIFIC_USER'] as const;
export const APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;

export type ApprovalEntityType = (typeof APPROVAL_ENTITY_TYPES)[number];
export type ApproverType = (typeof APPROVER_TYPES)[number];
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const approvalDecisionSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  comment: z.string().trim().max(1000).optional(),
});
export type ApprovalDecisionInput = z.infer<typeof approvalDecisionSchema>;

export const policyStepSchema = z.object({
  sequence: z.number().int().min(1).max(20),
  name: z.string().trim().min(2).max(120),
  approverType: z.enum(APPROVER_TYPES),
  approverRoleKey: z.string().trim().min(1).max(64).nullable().optional(),
  approverEmployeeId: z.string().uuid().nullable().optional(),
  /** Threshold routing: the step applies only at or above this amount. */
  minAmount: moneySchema.nullable().optional(),
});

export const createApprovalPolicySchema = z.object({
  entityType: z.enum(APPROVAL_ENTITY_TYPES),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(255).optional(),
  steps: z.array(policyStepSchema).min(1, 'A policy needs at least one step').max(20),
});
export type CreateApprovalPolicyInput = z.infer<typeof createApprovalPolicySchema>;

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

export const EXPENSE_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'REIMBURSED',
] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

export const createExpenseSchema = z.object({
  categoryId: z.string().uuid(),
  projectId: z.string().uuid().nullable().optional(),
  amount: moneySchema,
  currency: z.string().trim().toUpperCase().length(3).default('INR'),
  spentOn: dateOnlySchema,
  description: z.string().trim().min(3, 'Say what this was for').max(500),
  receiptKey: z.string().trim().max(255).optional(),
});
export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;

export const updateExpenseSchema = z.object({
  categoryId: z.string().uuid().optional(),
  projectId: z.string().uuid().nullable().optional(),
  amount: moneySchema.optional(),
  currency: z.string().trim().toUpperCase().length(3).optional(),
  spentOn: dateOnlySchema.optional(),
  description: z.string().trim().min(3).max(500).optional(),
  receiptKey: z.string().trim().max(255).nullable().optional(),
  version: z.number().int().min(0),
});
export type UpdateExpenseInput = z.infer<typeof updateExpenseSchema>;

export const expenseQuerySchema = z.object({
  status: z.enum(EXPENSE_STATUSES).optional(),
  employeeId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  /** Only my own claims — what an employee without `expense.read` sees. */
  mine: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
});

export const createExpenseCategorySchema = z.object({
  name: z.string().trim().min(2).max(80),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(2)
    .max(16)
    .regex(/^[A-Z0-9-]+$/),
  receiptRequiredAbove: moneySchema.nullable().optional(),
});

// ---------------------------------------------------------------------------
// Leave
// ---------------------------------------------------------------------------

export const LEAVE_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

export const createLeaveTypeSchema = z.object({
  name: z.string().trim().min(2).max(80),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(2)
    .max(16)
    .regex(/^[A-Z0-9-]+$/),
  /** Days per year. Zero means unlimited or unpaid. */
  annualQuota: z.coerce.number().min(0).max(365).default(0),
  isPaid: z.boolean().default(true),
  requiresApproval: z.boolean().default(true),
  colour: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #3ecf8e')
    .optional(),
});

export const createLeaveRequestSchema = z.object({
  leaveTypeId: z.string().uuid(),
  startDate: dateOnlySchema,
  endDate: dateOnlySchema,
  /** A half day applies to a single-date request. */
  halfDay: z.boolean().default(false),
  reason: z.string().trim().max(1000).optional(),
});
export type CreateLeaveRequestInput = z.infer<typeof createLeaveRequestSchema>;

export const leaveQuerySchema = z.object({
  status: z.enum(LEAVE_STATUSES).optional(),
  employeeId: z.string().uuid().optional(),
  mine: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
});

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface ApprovalStepView {
  id: string;
  sequence: number;
  name: string;
  approverType: ApproverType;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SKIPPED';
  approver: { id: string; firstName: string; lastName: string } | null;
  approverRoleKey: string | null;
  decidedBy: { id: string; name: string } | null;
  decidedAt: string | null;
  comment: string | null;
}

export interface ApprovalRequestView {
  id: string;
  entityType: ApprovalEntityType;
  entityId: string;
  status: ApprovalStatus;
  currentSequence: number | null;
  amount: string | null;
  currency: string | null;
  requester: { id: string; firstName: string; lastName: string };
  steps: ApprovalStepView[];
  createdAt: string;
}

export interface LeaveBalanceView {
  leaveType: { id: string; name: string; code: string; colour: string | null };
  year: number;
  entitled: number;
  used: number;
  pending: number;
  available: number;
}
