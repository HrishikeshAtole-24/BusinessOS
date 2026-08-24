import { BusinessRuleError, ERROR_CODES, ForbiddenError } from '@businessos/contracts';
import type { Prisma } from '@businessos/database';
import {
  materializeSteps,
  nextPendingStep,
  outcomeAfterDecision,
  type PolicyStepDefinition,
} from '@businessos/domain';
import { record } from '../../lib/audit.js';
import { approverUserIds, notify } from '../platform/notification.service.js';

/**
 * The approval engine — report Section 13.
 *
 * Leave and expenses both call `submitForApproval`; neither contains approval
 * logic of its own. That is the design goal from the origin transcript: build
 * one engine rather than a workflow per module.
 */

export type ApprovalEntityType = 'EXPENSE' | 'LEAVE';

export interface SubmitInput {
  organizationId: string;
  entityType: ApprovalEntityType;
  entityId: string;
  /** The employee the request is about. */
  requesterId: string;
  amount?: number | null;
  currency?: string | null;
  actorUserId: string;
  requestId: string;
  ipAddress?: string | null;
}

export interface SubmitResult {
  approvalRequestId: string;
  /** APPROVED immediately when no step resolved to anything actionable. */
  status: 'PENDING' | 'APPROVED';
  pendingStepName: string | null;
}

/**
 * Create an approval and materialise its steps.
 *
 * The requester's manager and department head are read here and passed into
 * `materializeSteps`, which stays pure. Approvers are snapshot at this moment,
 * so a later policy edit cannot rewrite an in-flight chain.
 */
export async function submitForApproval(
  tx: Prisma.TransactionClient,
  input: SubmitInput,
): Promise<SubmitResult> {
  const requester = await tx.employee.findFirst({
    where: { id: input.requesterId, organizationId: input.organizationId },
    select: {
      id: true,
      managerId: true,
      department: { select: { headId: true } },
    },
  });
  if (!requester) throw new BusinessRuleError('The requester has no employee record.');

  const policy = await tx.approvalPolicy.findFirst({
    where: {
      organizationId: input.organizationId,
      entityType: input.entityType,
      isActive: true,
    },
    select: {
      id: true,
      steps: {
        select: {
          sequence: true,
          name: true,
          approverType: true,
          approverRoleKey: true,
          approverEmployeeId: true,
          minAmount: true,
        },
        orderBy: { sequence: 'asc' },
      },
    },
  });

  const definitions: PolicyStepDefinition[] = (policy?.steps ?? []).map((step) => ({
    sequence: step.sequence,
    name: step.name,
    approverType: step.approverType,
    approverRoleKey: step.approverRoleKey,
    approverEmployeeId: step.approverEmployeeId,
    minAmount: step.minAmount === null ? null : Number(step.minAmount),
  }));

  const steps = materializeSteps(definitions, {
    requesterId: requester.id,
    amount: input.amount ?? null,
    managerId: requester.managerId,
    departmentHeadId: requester.department?.headId ?? null,
  });

  const pending = nextPendingStep(steps);
  // No policy, or every step skipped: auto-approve rather than strand the
  // request in a state nobody can act on.
  const status = pending === null ? 'APPROVED' : 'PENDING';

  const approval = await tx.approvalRequest.create({
    data: {
      organizationId: input.organizationId,
      entityType: input.entityType,
      entityId: input.entityId,
      policyId: policy?.id ?? null,
      requesterId: requester.id,
      status,
      currentSequence: pending?.sequence ?? null,
      resolvedAt: status === 'APPROVED' ? new Date() : null,
      ...(input.amount != null ? { amount: input.amount.toFixed(2) } : {}),
      ...(input.currency ? { currency: input.currency } : {}),
      steps: {
        create: steps.map((step) => ({
          sequence: step.sequence,
          name: step.name,
          approverType: step.approverType,
          approverEmployeeId: step.approverEmployeeId,
          approverRoleKey: step.approverRoleKey,
          status: step.status,
          // The skip reason belongs on the record: a chain with a silently
          // missing step is impossible to explain six months later.
          comment: step.skipReason ?? null,
        })),
      },
    },
    select: { id: true },
  });

  await record(tx, {
    organizationId: input.organizationId,
    actorId: input.actorUserId,
    action: 'approval.submitted',
    entityType: 'approval_request',
    entityId: approval.id,
    metadata: {
      subject: input.entityType,
      subjectId: input.entityId,
      steps: steps.length,
      actionable: steps.filter((s) => s.status === 'PENDING').length,
      autoApproved: status === 'APPROVED',
    },
    ipAddress: input.ipAddress ?? null,
    requestId: input.requestId,
  });

  /**
   * Tell the first approver, in the same transaction as the request itself.
   * An approval that committed always has its notification; queuing it after
   * commit would open a window where a live request is invisible to whoever
   * has to act on it.
   */
  if (pending) {
    await notify(tx, {
      organizationId: input.organizationId,
      recipientIds: await approverUserIds(tx, input.organizationId, {
        approverEmployeeId: pending.approverEmployeeId,
        approverRoleKey: pending.approverRoleKey,
      }),
      type: 'approval.requested',
      priority: 'HIGH',
      title: `${input.entityType === 'EXPENSE' ? 'Expense' : 'Leave'} approval needed`,
      body: `${pending.name} step is waiting on you.`,
      entityType: 'approval_request',
      entityId: approval.id,
      link: '/approvals',
      // Same request, same step, same person -> one notification however many
      // times the submit is retried.
      dedupeOn: `approval:${approval.id}:step:${pending.sequence}`,
    });
  }

  return {
    approvalRequestId: approval.id,
    status,
    pendingStepName: pending?.name ?? null,
  };
}

export interface DecisionInput {
  organizationId: string;
  approvalRequestId: string;
  decision: 'APPROVED' | 'REJECTED';
  comment?: string | null;
  /** Who is deciding. */
  actorUserId: string;
  actorEmployeeId: string | null;
  actorRoleKeys: readonly string[];
  requestId: string;
  ipAddress?: string | null;
}

export interface DecisionResult {
  requestStatus: 'PENDING' | 'APPROVED' | 'REJECTED';
  entityType: ApprovalEntityType;
  entityId: string;
  nextStepName: string | null;
}

/**
 * Record a decision on the current step and advance the request.
 *
 * Only the CURRENT step is decidable. Allowing a later approver to act early
 * would collapse an ordered chain into a set, and the order is usually the
 * control being asked for.
 */
export async function decide(
  tx: Prisma.TransactionClient,
  input: DecisionInput,
): Promise<DecisionResult> {
  const request = await tx.approvalRequest.findFirst({
    where: { id: input.approvalRequestId, organizationId: input.organizationId },
    select: {
      id: true,
      status: true,
      entityType: true,
      entityId: true,
      requesterId: true,
      currentSequence: true,
      steps: {
        select: {
          id: true,
          sequence: true,
          name: true,
          status: true,
          approverEmployeeId: true,
          approverRoleKey: true,
        },
        orderBy: { sequence: 'asc' },
      },
    },
  });
  if (!request) throw new BusinessRuleError('Approval request not found.');

  if (request.status !== 'PENDING') {
    throw new BusinessRuleError(
      `This request is already ${request.status.toLowerCase()}.`,
      ERROR_CODES.INVALID_STATE_TRANSITION,
    );
  }

  const step = request.steps.find(
    (s) => s.status === 'PENDING' && s.sequence === request.currentSequence,
  );
  if (!step) throw new BusinessRuleError('There is no step awaiting a decision.');

  /**
   * Authorisation, and the reason this lives here rather than in a route guard:
   * `approval.act` says you may act on approvals *assigned to you*. Which ones
   * those are is per-record, so the permission alone is not sufficient.
   */
  const isNamedApprover =
    step.approverEmployeeId !== null && step.approverEmployeeId === input.actorEmployeeId;
  const holdsRole =
    step.approverRoleKey !== null && input.actorRoleKeys.includes(step.approverRoleKey);

  if (!isNamedApprover && !holdsRole) {
    throw new ForbiddenError('This approval step is not assigned to you.', {
      step: step.name,
    });
  }

  // Belt and braces. `materializeSteps` already skips self-approval, but a
  // ROLE step resolves to whoever holds the role — and the requester might.
  if (input.actorEmployeeId !== null && input.actorEmployeeId === request.requesterId) {
    throw new ForbiddenError('You cannot approve your own request.');
  }

  await tx.approvalStep.update({
    where: { id: step.id },
    data: {
      status: input.decision,
      decidedById: input.actorUserId,
      decidedAt: new Date(),
      comment: input.comment ?? null,
    },
  });

  const updatedSteps = request.steps.map((s) =>
    s.id === step.id ? { ...s, status: input.decision } : s,
  );
  const outcome = outcomeAfterDecision(updatedSteps);
  const next = outcome === 'PENDING' ? nextPendingStep(updatedSteps) : null;

  await tx.approvalRequest.update({
    where: { id: request.id },
    data: {
      status: outcome,
      currentSequence: next?.sequence ?? null,
      resolvedAt: outcome === 'PENDING' ? null : new Date(),
      version: { increment: 1 },
    },
  });

  await record(tx, {
    organizationId: input.organizationId,
    actorId: input.actorUserId,
    action: input.decision === 'APPROVED' ? 'approval.step_approved' : 'approval.step_rejected',
    entityType: 'approval_request',
    entityId: request.id,
    metadata: {
      step: step.name,
      sequence: step.sequence,
      outcome,
      subject: request.entityType,
      subjectId: request.entityId,
    },
    ipAddress: input.ipAddress ?? null,
    requestId: input.requestId,
  });

  if (next) {
    await notify(tx, {
      organizationId: input.organizationId,
      recipientIds: await approverUserIds(tx, input.organizationId, {
        approverEmployeeId: next.approverEmployeeId,
        approverRoleKey: next.approverRoleKey,
      }),
      type: 'approval.requested',
      priority: 'HIGH',
      title: `${request.entityType === 'EXPENSE' ? 'Expense' : 'Leave'} approval needed`,
      body: `${next.name} step is waiting on you.`,
      entityType: 'approval_request',
      entityId: request.id,
      link: '/approvals',
      dedupeOn: `approval:${request.id}:step:${next.sequence}`,
    });
  } else {
    // Resolved: tell the person who asked.
    const requester = await tx.employee.findUnique({
      where: { id: request.requesterId },
      select: { userId: true },
    });
    if (requester?.userId) {
      await notify(tx, {
        organizationId: input.organizationId,
        recipientIds: [requester.userId],
        type: `approval.${outcome.toLowerCase()}`,
        priority: outcome === 'REJECTED' ? 'HIGH' : 'NORMAL',
        title: `Your ${request.entityType.toLowerCase()} was ${outcome.toLowerCase()}`,
        ...(input.comment ? { body: input.comment } : {}),
        entityType: 'approval_request',
        entityId: request.id,
        link: request.entityType === 'EXPENSE' ? '/expenses' : '/leave',
        dedupeOn: `approval:${request.id}:outcome`,
      });
    }
  }

  return {
    requestStatus: outcome,
    entityType: request.entityType,
    entityId: request.entityId,
    nextStepName: next?.name ?? null,
  };
}

/** Cancel a live approval, e.g. because the underlying request was withdrawn. */
export async function cancel(
  tx: Prisma.TransactionClient,
  organizationId: string,
  entityType: ApprovalEntityType,
  entityId: string,
): Promise<void> {
  await tx.approvalRequest.updateMany({
    where: { organizationId, entityType, entityId, status: 'PENDING' },
    data: { status: 'CANCELLED', currentSequence: null, resolvedAt: new Date() },
  });
}
