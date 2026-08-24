import {
  NotFoundError,
  approvalDecisionSchema,
  createApprovalPolicySchema,
} from '@businessos/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { record } from '../../lib/audit.js';
import { prisma } from '../../lib/prisma.js';
import { decide } from './approval.service.js';

/**
 * Approval inbox and policy administration.
 *
 * The domain modules (expenses, leave) submit into the engine; this is where
 * decisions come back in.
 */

const idParam = z.object({ approvalId: z.string().uuid() });

const stepSelect = {
  id: true,
  sequence: true,
  name: true,
  approverType: true,
  approverRoleKey: true,
  status: true,
  decidedAt: true,
  comment: true,
  approver: { select: { id: true, firstName: true, lastName: true } },
  decidedBy: { select: { id: true, name: true } },
} as const;

/** The employee record for the signed-in user, if they have one. */
async function actorEmployee(organizationId: string, userId: string) {
  return prisma.employee.findFirst({
    where: { organizationId, userId },
    select: { id: true },
  });
}

export function approvalRoutes(app: FastifyInstance, _opts: unknown, done: () => void): void {
  /**
   * GET /v1/approvals/inbox
   *
   * What is waiting on ME right now.
   *
   * A step is mine when it names me directly, OR when it names a role I hold
   * and nobody has decided yet. Filtering on `currentSequence` matters: only
   * the step the request is actually on is actionable, so a later step I own
   * must not appear yet.
   */
  app.get(
    '/v1/approvals/inbox',
    { preHandler: app.requirePermission('approval.read') },
    async (request) => {
      const { organizationId, roles } = request.membership!;
      const me = await actorEmployee(organizationId, request.auth!.userId);

      const pending = await prisma.approvalRequest.findMany({
        where: {
          organizationId,
          status: 'PENDING',
          // Never show someone their own request as actionable.
          ...(me ? { requesterId: { not: me.id } } : {}),
          steps: {
            some: {
              status: 'PENDING',
              OR: [
                ...(me ? [{ approverEmployeeId: me.id }] : []),
                ...(roles.length > 0 ? [{ approverRoleKey: { in: [...roles] } }] : []),
              ],
            },
          },
        },
        select: {
          id: true,
          entityType: true,
          entityId: true,
          amount: true,
          currency: true,
          currentSequence: true,
          createdAt: true,
          requester: { select: { id: true, firstName: true, lastName: true } },
          steps: { select: stepSelect, orderBy: { sequence: 'asc' } },
        },
        orderBy: { createdAt: 'asc' },
        take: 100,
      });

      // Keep only those whose CURRENT step is one I can act on. The query above
      // matches any pending step; this narrows it to the live one.
      const actionable = pending.filter((approval) => {
        const current = approval.steps.find(
          (s) => s.sequence === approval.currentSequence && s.status === 'PENDING',
        );
        if (!current) return false;
        return (
          (me !== null && current.approver?.id === me.id) ||
          (current.approverRoleKey !== null && roles.includes(current.approverRoleKey))
        );
      });

      return {
        data: actionable.map(serialize),
        total: actionable.length,
      };
    },
  );

  /** GET /v1/approvals/:approvalId */
  app.get(
    '/v1/approvals/:approvalId',
    { preHandler: app.requirePermission('approval.read') },
    async (request) => {
      const { approvalId } = idParam.parse(request.params);
      const { organizationId } = request.membership!;

      const approval = await prisma.approvalRequest.findFirst({
        where: { id: approvalId, organizationId },
        select: {
          id: true,
          entityType: true,
          entityId: true,
          status: true,
          amount: true,
          currency: true,
          currentSequence: true,
          createdAt: true,
          requester: { select: { id: true, firstName: true, lastName: true } },
          steps: { select: stepSelect, orderBy: { sequence: 'asc' } },
        },
      });
      if (!approval) throw new NotFoundError('Approval request');

      return serialize(approval);
    },
  );

  /**
   * POST /v1/approvals/:approvalId/decide
   *
   * `approval.act` grants the ability to act on approvals assigned to you. Which
   * ones those are is per-record, so the service checks assignment — the route
   * guard alone would let any holder decide anyone's step.
   */
  app.post(
    '/v1/approvals/:approvalId/decide',
    { preHandler: app.requirePermission('approval.act') },
    async (request) => {
      const { approvalId } = idParam.parse(request.params);
      const input = approvalDecisionSchema.parse(request.body);
      const { organizationId, roles } = request.membership!;
      const auth = request.auth!;

      const me = await actorEmployee(organizationId, auth.userId);

      return prisma.$transaction(async (tx) => {
        const result = await decide(tx, {
          organizationId,
          approvalRequestId: approvalId,
          decision: input.decision,
          comment: input.comment ?? null,
          actorUserId: auth.userId,
          actorEmployeeId: me?.id ?? null,
          actorRoleKeys: roles,
          requestId: request.id,
          ipAddress: request.ip,
        });

        /**
         * Propagate the outcome to the thing being approved.
         *
         * Done inside the same transaction as the decision. If the expense
         * status and its approval could diverge, an approved expense might
         * never become reimbursable — the classic dual-write failure.
         */
        if (result.requestStatus !== 'PENDING') {
          const resolvedAt = new Date();
          if (result.entityType === 'EXPENSE') {
            await tx.expense.updateMany({
              where: { id: result.entityId, organizationId, status: 'SUBMITTED' },
              data: {
                status: result.requestStatus === 'APPROVED' ? 'APPROVED' : 'REJECTED',
                resolvedAt,
                version: { increment: 1 },
              },
            });
          } else {
            await applyLeaveOutcome(tx, organizationId, result.entityId, result.requestStatus);
          }
        }

        return result;
      });
    },
  );

  /** GET /v1/approval-policies */
  app.get(
    '/v1/approval-policies',
    { preHandler: app.requirePermission('approval.read') },
    async (request) => {
      const policies = await prisma.approvalPolicy.findMany({
        where: { organizationId: request.membership!.organizationId },
        select: {
          id: true,
          entityType: true,
          name: true,
          description: true,
          isActive: true,
          steps: {
            select: {
              sequence: true,
              name: true,
              approverType: true,
              approverRoleKey: true,
              minAmount: true,
              approver: { select: { id: true, firstName: true, lastName: true } },
            },
            orderBy: { sequence: 'asc' },
          },
        },
        orderBy: { entityType: 'asc' },
      });

      return {
        data: policies.map((p) => ({
          ...p,
          steps: p.steps.map((s) => ({ ...s, minAmount: s.minAmount?.toString() ?? null })),
        })),
      };
    },
  );

  /** POST /v1/approval-policies */
  app.post(
    '/v1/approval-policies',
    { preHandler: app.requirePermission('role.manage') },
    async (request, reply) => {
      const input = createApprovalPolicySchema.parse(request.body);
      const { organizationId } = request.membership!;

      const policy = await prisma.$transaction(async (tx) => {
        // One active policy per entity type: two would make routing ambiguous,
        // and ambiguity in an approval chain is a hole.
        await tx.approvalPolicy.updateMany({
          where: { organizationId, entityType: input.entityType, isActive: true },
          data: { isActive: false },
        });

        const created = await tx.approvalPolicy.create({
          data: {
            organizationId,
            entityType: input.entityType,
            name: input.name,
            description: input.description ?? null,
            isActive: true,
            steps: {
              create: input.steps.map((step) => ({
                sequence: step.sequence,
                name: step.name,
                approverType: step.approverType,
                approverRoleKey: step.approverRoleKey ?? null,
                approverEmployeeId: step.approverEmployeeId ?? null,
                minAmount: step.minAmount ?? null,
              })),
            },
          },
          select: { id: true, name: true, entityType: true },
        });

        await record(tx, {
          organizationId,
          actorId: request.auth!.userId,
          action: 'approval.policy_created',
          entityType: 'approval_policy',
          entityId: created.id,
          metadata: {
            name: created.name,
            entityType: created.entityType,
            steps: input.steps.length,
          },
          ipAddress: request.ip,
          requestId: request.id,
        });

        return created;
      });

      return reply.status(201).send(policy);
    },
  );

  done();
}

/**
 * Apply an approval outcome to a leave request, moving balance from `pending`
 * to `used` on approval, or releasing it on rejection.
 *
 * Exported-by-import into the expenses/leave modules would be circular, so it
 * lives here beside the only place that calls it.
 */
async function applyLeaveOutcome(
  tx: Parameters<typeof decide>[0],
  organizationId: string,
  leaveRequestId: string,
  outcome: 'APPROVED' | 'REJECTED',
): Promise<void> {
  const leave = await tx.leaveRequest.findFirst({
    where: { id: leaveRequestId, organizationId, status: 'SUBMITTED' },
    select: { id: true, employeeId: true, leaveTypeId: true, days: true, startDate: true },
  });
  if (!leave) return;

  await tx.leaveRequest.updateMany({
    where: { id: leaveRequestId, organizationId },
    data: {
      status: outcome,
      resolvedAt: new Date(),
      version: { increment: 1 },
    },
  });

  const year = leave.startDate.getUTCFullYear();
  const days = Number(leave.days);

  const balance = await tx.leaveBalance.findFirst({
    where: { employeeId: leave.employeeId, leaveTypeId: leave.leaveTypeId, year },
    select: { id: true },
  });
  if (!balance) return;

  // Approval converts the hold into consumption; rejection just releases it.
  await tx.leaveBalance.update({
    where: { id: balance.id },
    data:
      outcome === 'APPROVED'
        ? { pending: { decrement: days }, used: { increment: days }, version: { increment: 1 } }
        : { pending: { decrement: days }, version: { increment: 1 } },
  });
}

function serialize(approval: {
  amount: { toString(): string } | null;
  createdAt: Date;
  steps: Array<{ decidedAt: Date | null }>;
  [key: string]: unknown;
}) {
  return {
    ...approval,
    amount: approval.amount?.toString() ?? null,
    createdAt: approval.createdAt.toISOString(),
    steps: approval.steps.map((step) => ({
      ...step,
      decidedAt: step.decidedAt?.toISOString() ?? null,
    })),
  };
}
