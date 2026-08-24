import {
  BusinessRuleError,
  ERROR_CODES,
  ForbiddenError,
  NotFoundError,
  buildPage,
  createLeaveRequestSchema,
  createLeaveTypeSchema,
  leaveQuerySchema,
  toPrismaPageArgs,
} from '@businessos/contracts';
import { leaveStateMachine } from '@businessos/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { record } from '../../lib/audit.js';
import { definedOnly } from '../../lib/defined.js';
import { prisma } from '../../lib/prisma.js';
import { cancel, submitForApproval } from '../workflow/approval.service.js';

/**
 * Leave requests and balances (report Section 3.1).
 *
 * Like expenses, this contains no approval logic — it submits into the engine.
 * What is specific here is the balance, and Section 20.2 names "concurrent
 * leave-balance updates" as a critical test: two requests approved at the same
 * instant must not both spend the same days.
 */

const idParam = z.object({ leaveRequestId: z.string().uuid() });

async function requireOwnEmployee(organizationId: string, userId: string) {
  const employee = await prisma.employee.findFirst({
    where: { organizationId, userId },
    select: { id: true, managerId: true },
  });
  if (!employee) {
    throw new BusinessRuleError(
      'Your account is not linked to an employee record, so you cannot request leave.',
    );
  }
  return employee;
}

/**
 * Working days between two dates, inclusive, excluding weekends.
 *
 * A public-holiday calendar belongs here too and is not built yet; the result
 * is stored on the request rather than recomputed, so adding one later cannot
 * silently rewrite the length of leave already taken.
 */
function workingDays(start: Date, end: Date, halfDay: boolean): number {
  let days = 0;
  const cursor = new Date(start);
  while (cursor <= end) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) days += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  if (halfDay && days === 1) return 0.5;
  return days;
}

export function leaveRoutes(app: FastifyInstance, _opts: unknown, done: () => void): void {
  /** GET /v1/leave-types */
  app.get(
    '/v1/leave-types',
    { preHandler: app.requirePermission('leave.read_self') },
    async (request) => {
      const types = await prisma.leaveType.findMany({
        where: { organizationId: request.membership!.organizationId },
        select: {
          id: true,
          name: true,
          code: true,
          annualQuota: true,
          isPaid: true,
          requiresApproval: true,
          colour: true,
        },
        orderBy: { name: 'asc' },
      });
      return { data: types.map((t) => ({ ...t, annualQuota: Number(t.annualQuota) })) };
    },
  );

  /** POST /v1/leave-types */
  app.post(
    '/v1/leave-types',
    { preHandler: app.requirePermission('leave.manage_policy') },
    async (request, reply) => {
      const input = createLeaveTypeSchema.parse(request.body);
      const { organizationId } = request.membership!;

      const type = await prisma.leaveType.create({
        data: {
          organizationId,
          name: input.name,
          code: input.code,
          annualQuota: input.annualQuota,
          isPaid: input.isPaid,
          requiresApproval: input.requiresApproval,
          ...definedOnly({ colour: input.colour }),
        },
        select: { id: true, name: true, code: true },
      });
      return reply.status(201).send(type);
    },
  );

  /**
   * GET /v1/leave-balances
   *
   * `available` is entitled - used - pending. Pending is included so someone
   * cannot book the same days twice by submitting two requests before either
   * is approved.
   */
  app.get(
    '/v1/leave-balances',
    { preHandler: app.requirePermission('leave.read_self') },
    async (request) => {
      const { organizationId, permissions } = request.membership!;
      const query = z
        .object({ employeeId: z.string().uuid().optional(), year: z.coerce.number().optional() })
        .parse(request.query);

      const me = await prisma.employee.findFirst({
        where: { organizationId, userId: request.auth!.userId },
        select: { id: true },
      });

      // Someone else's balance needs `leave.read`; your own only needs read_self.
      const targetId =
        query.employeeId && permissions.has('leave.read') ? query.employeeId : me?.id;
      if (!targetId) return { data: [] };

      const year = query.year ?? new Date().getUTCFullYear();

      const balances = await prisma.leaveBalance.findMany({
        where: { organizationId, employeeId: targetId, year },
        select: {
          year: true,
          entitled: true,
          used: true,
          pending: true,
          leaveType: { select: { id: true, name: true, code: true, colour: true } },
        },
      });

      return {
        data: balances.map((b) => {
          const entitled = Number(b.entitled);
          const used = Number(b.used);
          const pending = Number(b.pending);
          return {
            leaveType: b.leaveType,
            year: b.year,
            entitled,
            used,
            pending,
            available: entitled - used - pending,
          };
        }),
      };
    },
  );

  /** GET /v1/leave-requests */
  app.get(
    '/v1/leave-requests',
    { preHandler: app.requirePermission('leave.read_self') },
    async (request) => {
      const query = leaveQuerySchema.parse(request.query);
      const { organizationId, permissions } = request.membership!;
      const canSeeOthers = permissions.has('leave.read');

      const me = await prisma.employee.findFirst({
        where: { organizationId, userId: request.auth!.userId },
        select: { id: true },
      });

      const employeeFilter = canSeeOthers
        ? definedOnly({ employeeId: query.mine ? me?.id : query.employeeId })
        : { employeeId: me?.id ?? '00000000-0000-0000-0000-000000000000' };

      const rows = await prisma.leaveRequest.findMany({
        where: {
          organizationId,
          ...employeeFilter,
          ...definedOnly({ status: query.status }),
        },
        select: {
          id: true,
          status: true,
          startDate: true,
          endDate: true,
          days: true,
          halfDay: true,
          reason: true,
          submittedAt: true,
          version: true,
          employee: { select: { id: true, firstName: true, lastName: true } },
          leaveType: { select: { id: true, name: true, code: true, colour: true } },
        },
        orderBy: { id: 'asc' },
        ...toPrismaPageArgs(query),
      });

      const page = buildPage(rows, query.limit);
      return {
        data: page.data.map(serialize),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
        scope: canSeeOthers ? 'organization' : 'self',
      };
    },
  );

  /**
   * POST /v1/leave-requests
   *
   * Creates and submits in one call, because a draft leave request is not a
   * useful state — you either ask for the days or you do not.
   */
  app.post(
    '/v1/leave-requests',
    { preHandler: app.requirePermission('leave.request') },
    async (request, reply) => {
      const input = createLeaveRequestSchema.parse(request.body);
      const { organizationId } = request.membership!;
      const auth = request.auth!;
      const me = await requireOwnEmployee(organizationId, auth.userId);

      if (input.endDate < input.startDate) {
        throw new BusinessRuleError('The end date cannot be before the start date.');
      }

      const leaveType = await prisma.leaveType.findFirst({
        where: { id: input.leaveTypeId, organizationId },
        select: { id: true, name: true, isPaid: true, annualQuota: true },
      });
      if (!leaveType) throw new NotFoundError('Leave type');

      const start = new Date(input.startDate);
      const end = new Date(input.endDate);
      const days = workingDays(start, end, input.halfDay);
      if (days <= 0) {
        throw new BusinessRuleError('That range contains no working days.');
      }

      // Overlapping requests are almost always a mistake, and would double-spend
      // the balance if both were approved.
      const overlap = await prisma.leaveRequest.findFirst({
        where: {
          organizationId,
          employeeId: me.id,
          status: { in: ['SUBMITTED', 'APPROVED'] },
          startDate: { lte: end },
          endDate: { gte: start },
        },
        select: { id: true, startDate: true, endDate: true },
      });
      if (overlap) {
        throw new BusinessRuleError(
          'You already have leave requested over some of those dates.',
          ERROR_CODES.BUSINESS_RULE_VIOLATION,
          {
            from: overlap.startDate.toISOString().slice(0, 10),
            to: overlap.endDate.toISOString().slice(0, 10),
          },
        );
      }

      const year = start.getUTCFullYear();

      return prisma.$transaction(async (tx) => {
        const leave = await tx.leaveRequest.create({
          data: {
            organizationId,
            employeeId: me.id,
            leaveTypeId: input.leaveTypeId,
            startDate: start,
            endDate: end,
            days,
            halfDay: input.halfDay,
            status: 'SUBMITTED',
            submittedAt: new Date(),
            ...definedOnly({ reason: input.reason }),
          },
          select: { id: true },
        });

        /**
         * Reserve the days before approval.
         *
         * The balance row is created on demand from the type's annual quota.
         * `updateMany` with a version guard is the concurrency control from
         * Section 11.2: two simultaneous requests cannot both pass the check
         * and then both deduct.
         */
        if (leaveType.isPaid && Number(leaveType.annualQuota) > 0) {
          const balance = await tx.leaveBalance.upsert({
            where: {
              employeeId_leaveTypeId_year: {
                employeeId: me.id,
                leaveTypeId: input.leaveTypeId,
                year,
              },
            },
            update: {},
            create: {
              organizationId,
              employeeId: me.id,
              leaveTypeId: input.leaveTypeId,
              year,
              entitled: leaveType.annualQuota,
            },
            select: { id: true, entitled: true, used: true, pending: true, version: true },
          });

          const available =
            Number(balance.entitled) - Number(balance.used) - Number(balance.pending);
          if (days > available) {
            throw new BusinessRuleError(
              `Only ${available} day(s) of ${leaveType.name} left.`,
              ERROR_CODES.INSUFFICIENT_LEAVE_BALANCE,
              { requested: days, available },
            );
          }

          const held = await tx.leaveBalance.updateMany({
            where: { id: balance.id, version: balance.version },
            data: { pending: { increment: days }, version: { increment: 1 } },
          });
          // Zero rows means someone else moved the balance between our read and
          // our write — exactly the race this guard exists for.
          if (held.count === 0) {
            throw new BusinessRuleError(
              'Your leave balance changed while this was being processed. Try again.',
              ERROR_CODES.VERSION_CONFLICT,
            );
          }
        }

        const approval = await submitForApproval(tx, {
          organizationId,
          entityType: 'LEAVE',
          entityId: leave.id,
          requesterId: me.id,
          amount: null,
          actorUserId: auth.userId,
          requestId: request.id,
          ipAddress: request.ip,
        });

        // Auto-approved (no policy, or nothing actionable): convert the hold
        // into consumption immediately.
        if (approval.status === 'APPROVED') {
          await tx.leaveRequest.update({
            where: { id: leave.id },
            data: { status: 'APPROVED', resolvedAt: new Date(), version: { increment: 1 } },
          });
          await tx.leaveBalance.updateMany({
            where: { employeeId: me.id, leaveTypeId: input.leaveTypeId, year },
            data: {
              pending: { decrement: days },
              used: { increment: days },
              version: { increment: 1 },
            },
          });
        }

        return reply.status(201).send({
          id: leave.id,
          days,
          status: approval.status === 'APPROVED' ? 'APPROVED' : 'SUBMITTED',
          approvalRequestId: approval.approvalRequestId,
          awaiting: approval.pendingStepName,
        });
      });
    },
  );

  /**
   * POST /v1/leave-requests/:id/cancel
   *
   * Cancelling must refund the balance, which is why this is a transition
   * rather than a delete.
   */
  app.post(
    '/v1/leave-requests/:leaveRequestId/cancel',
    { preHandler: app.requirePermission('leave.request') },
    async (request) => {
      const { leaveRequestId } = idParam.parse(request.params);
      const { organizationId } = request.membership!;
      const me = await requireOwnEmployee(organizationId, request.auth!.userId);

      const leave = await prisma.leaveRequest.findFirst({
        where: { id: leaveRequestId, organizationId },
        select: {
          employeeId: true,
          status: true,
          days: true,
          leaveTypeId: true,
          startDate: true,
        },
      });
      if (!leave) throw new NotFoundError('Leave request');
      if (leave.employeeId !== me.id) {
        throw new ForbiddenError('You can only cancel your own leave.');
      }

      const check = leaveStateMachine.check(leave.status, 'CANCELLED');
      if (!check.ok) {
        throw new BusinessRuleError(
          `A ${leave.status.toLowerCase()} request cannot be cancelled.`,
          ERROR_CODES.INVALID_STATE_TRANSITION,
        );
      }

      const days = Number(leave.days);
      const year = leave.startDate.getUTCFullYear();

      return prisma.$transaction(async (tx) => {
        await cancel(tx, organizationId, 'LEAVE', leaveRequestId);
        await tx.leaveRequest.update({
          where: { id: leaveRequestId },
          data: { status: 'CANCELLED', resolvedAt: new Date(), version: { increment: 1 } },
        });

        // Release from wherever the days were held: `pending` if it was still
        // awaiting a decision, `used` if it had been approved.
        await tx.leaveBalance.updateMany({
          where: { employeeId: leave.employeeId, leaveTypeId: leave.leaveTypeId, year },
          data:
            leave.status === 'APPROVED'
              ? { used: { decrement: days }, version: { increment: 1 } }
              : { pending: { decrement: days }, version: { increment: 1 } },
        });

        await record(tx, {
          organizationId,
          actorId: request.auth!.userId,
          action: 'leave.cancelled',
          entityType: 'leave_request',
          entityId: leaveRequestId,
          metadata: { days, refundedFrom: leave.status === 'APPROVED' ? 'used' : 'pending' },
          ipAddress: request.ip,
          requestId: request.id,
        });

        return { leaveRequestId, status: 'CANCELLED', refundedDays: days };
      });
    },
  );

  done();
}

function serialize<
  T extends { startDate: Date; endDate: Date; days: unknown; submittedAt: Date | null },
>(leave: T) {
  return {
    ...leave,
    startDate: leave.startDate.toISOString().slice(0, 10),
    endDate: leave.endDate.toISOString().slice(0, 10),
    days: Number(leave.days),
    submittedAt: leave.submittedAt?.toISOString() ?? null,
  };
}
