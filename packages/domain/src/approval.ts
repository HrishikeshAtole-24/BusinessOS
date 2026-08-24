import { StateMachine } from './state-machine.js';

/**
 * Approval routing — report Section 13.
 *
 * The engine's whole point is that leave, expenses, purchases and WFH share one
 * implementation. What differs between them is a row in a policy table, not a
 * second copy of this logic.
 *
 * Pure functions. Resolving an approver needs facts about the requester —
 * their manager, their department head — so those are passed in as a context
 * rather than fetched here, which keeps this testable without a database.
 */

export const APPROVER_TYPES = ['MANAGER', 'DEPARTMENT_HEAD', 'ROLE', 'SPECIFIC_USER'] as const;
export type ApproverType = (typeof APPROVER_TYPES)[number];

export interface PolicyStepDefinition {
  sequence: number;
  name: string;
  approverType: ApproverType;
  approverRoleKey?: string | null;
  approverEmployeeId?: string | null;
  /** Threshold routing: the step applies only at or above this amount. */
  minAmount?: number | null;
}

export interface ResolutionContext {
  /** The employee the request is about. */
  requesterId: string;
  /** Amount, for threshold steps. Absent means every threshold step is skipped. */
  amount?: number | null;
  /** Employee.managerId of the requester. */
  managerId?: string | null;
  /** Head of the requester's department. */
  departmentHeadId?: string | null;
}

export type MaterializedStatus = 'PENDING' | 'SKIPPED';

export interface MaterializedStep {
  sequence: number;
  name: string;
  approverType: ApproverType;
  /** Resolved person, or null for a ROLE step where any holder may decide. */
  approverEmployeeId: string | null;
  approverRoleKey: string | null;
  status: MaterializedStatus;
  /** Why it was skipped, for the audit trail and the UI. */
  skipReason?: string;
}

/**
 * Turn a policy into the concrete steps of one live request.
 *
 * This is a **snapshot**. Approvers are resolved now and stored, so editing the
 * policy afterwards cannot retroactively change who is approving something
 * already in flight, or reorder a chain someone has already acted on. Resolving
 * lazily at each step would be simpler and would produce exactly that bug.
 *
 * Four rules decide whether a step survives:
 *
 *   1. **Threshold.** A step with `minAmount` above the request amount does not
 *      apply — a director does not sign off a ₹200 taxi.
 *   2. **Unresolvable.** MANAGER with no manager, or DEPARTMENT_HEAD with no
 *      head, is skipped rather than left pending forever. A step nobody can act
 *      on is a request that never completes.
 *   3. **Self-approval.** If the resolved approver is the requester, the step is
 *      skipped. A manager filing their own expense must not approve it because
 *      the policy happens to name "the requester's manager".
 *   4. **Consecutive duplicates.** If the same person would decide two steps in
 *      a row — often the manager is also the department head — they are asked
 *      once. Asking twice is theatre, not control.
 */
export function materializeSteps(
  definitions: readonly PolicyStepDefinition[],
  context: ResolutionContext,
): MaterializedStep[] {
  const ordered = [...definitions].sort((a, b) => a.sequence - b.sequence);
  const steps: MaterializedStep[] = [];

  for (const definition of ordered) {
    const base = {
      sequence: definition.sequence,
      name: definition.name,
      approverType: definition.approverType,
      approverRoleKey: definition.approverRoleKey ?? null,
    };

    // 1. Threshold.
    if (definition.minAmount != null) {
      const amount = context.amount ?? 0;
      if (amount < definition.minAmount) {
        steps.push({
          ...base,
          approverEmployeeId: null,
          status: 'SKIPPED',
          skipReason: `Amount below the ${definition.minAmount} threshold`,
        });
        continue;
      }
    }

    const resolved = resolveApprover(definition, context);

    // 2. Unresolvable.
    if (resolved.employeeId === null && definition.approverType !== 'ROLE') {
      steps.push({
        ...base,
        approverEmployeeId: null,
        status: 'SKIPPED',
        skipReason: resolved.reason ?? 'No approver could be resolved',
      });
      continue;
    }

    // 3. Self-approval.
    if (resolved.employeeId !== null && resolved.employeeId === context.requesterId) {
      steps.push({
        ...base,
        approverEmployeeId: null,
        status: 'SKIPPED',
        skipReason: 'Approver is the requester',
      });
      continue;
    }

    // 4. Consecutive duplicate.
    const previous = lastActionable(steps);
    if (
      previous &&
      resolved.employeeId !== null &&
      previous.approverEmployeeId === resolved.employeeId
    ) {
      steps.push({
        ...base,
        approverEmployeeId: null,
        status: 'SKIPPED',
        skipReason: 'Same approver as the previous step',
      });
      continue;
    }

    steps.push({
      ...base,
      approverEmployeeId: resolved.employeeId,
      status: 'PENDING',
    });
  }

  return steps;
}

function lastActionable(steps: readonly MaterializedStep[]): MaterializedStep | undefined {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (steps[i]!.status === 'PENDING') return steps[i];
  }
  return undefined;
}

function resolveApprover(
  definition: PolicyStepDefinition,
  context: ResolutionContext,
): { employeeId: string | null; reason?: string } {
  switch (definition.approverType) {
    case 'MANAGER':
      return context.managerId
        ? { employeeId: context.managerId }
        : { employeeId: null, reason: 'The requester has no manager' };

    case 'DEPARTMENT_HEAD':
      return context.departmentHeadId
        ? { employeeId: context.departmentHeadId }
        : { employeeId: null, reason: 'The department has no head' };

    case 'SPECIFIC_USER':
      return definition.approverEmployeeId
        ? { employeeId: definition.approverEmployeeId }
        : { employeeId: null, reason: 'No approver named on the policy step' };

    case 'ROLE':
      // Left unresolved on purpose: any holder of the role may decide, and
      // pinning one person at submission time would create a bottleneck the
      // moment they go on leave.
      return { employeeId: null };
  }
}

/**
 * The first step still awaiting a decision.
 *
 * Returns null when every step is resolved, which is the signal that the whole
 * request is approved.
 */
export function nextPendingStep<T extends { sequence: number; status: string }>(
  steps: readonly T[],
): T | null {
  return (
    [...steps].sort((a, b) => a.sequence - b.sequence).find((step) => step.status === 'PENDING') ??
    null
  );
}

/**
 * Outcome of the request after a decision on one step.
 *
 * A single rejection ends the whole request: approval chains are conjunctive,
 * so there is nothing to gain by asking the remaining approvers.
 */
export function outcomeAfterDecision<T extends { sequence: number; status: string }>(
  steps: readonly T[],
): 'PENDING' | 'APPROVED' | 'REJECTED' {
  if (steps.some((step) => step.status === 'REJECTED')) return 'REJECTED';
  return nextPendingStep(steps) === null ? 'APPROVED' : 'PENDING';
}

// ---------------------------------------------------------------------------
// State machines — Section 8.2 and 8.3
// ---------------------------------------------------------------------------

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

/** Section 8.3. Every non-pending state is terminal: a decision is final. */
export const approvalStateMachine = new StateMachine<ApprovalStatus>({
  PENDING: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: [],
  REJECTED: [],
  CANCELLED: [],
});

export type ExpenseStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'REIMBURSED';

/**
 * Section 8.2.
 *
 * REJECTED returns to DRAFT so a claim can be corrected and resubmitted rather
 * than retyped. REIMBURSED is terminal: money has moved, and reversing that is
 * a new transaction, not a status change.
 */
export const expenseStateMachine = new StateMachine<ExpenseStatus>({
  DRAFT: ['SUBMITTED'],
  SUBMITTED: ['APPROVED', 'REJECTED'],
  APPROVED: ['REIMBURSED', 'REJECTED'],
  REJECTED: ['DRAFT'],
  REIMBURSED: [],
});

export type LeaveStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

/**
 * APPROVED can still be cancelled — plans change, and cancelling must return
 * the days to the balance. That refund is why cancellation is a transition
 * here rather than a delete.
 */
export const leaveStateMachine = new StateMachine<LeaveStatus>({
  DRAFT: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['CANCELLED'],
  REJECTED: ['DRAFT'],
  CANCELLED: [],
});
