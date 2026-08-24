import {
  BusinessRuleError,
  ForbiddenError,
  InvalidStateTransitionError,
  NotFoundError,
  VersionConflictError,
  buildPage,
  createExpenseCategorySchema,
  createExpenseSchema,
  expenseQuerySchema,
  toPrismaPageArgs,
  updateExpenseSchema,
} from '@businessos/contracts';
import { expenseStateMachine } from '@businessos/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { diff, record } from '../../lib/audit.js';
import { definedOnly } from '../../lib/defined.js';
import { prisma } from '../../lib/prisma.js';
import { cancel, submitForApproval } from '../workflow/approval.service.js';

/**
 * Expense claims (report Section 3.1).
 *
 * Contains no approval logic. Submitting hands off to the engine, and the
 * engine hands the outcome back — which is the whole point of Section 13.
 */

const idParam = z.object({ expenseId: z.string().uuid() });

const expenseSelect = {
  id: true,
  amount: true,
  currency: true,
  spentOn: true,
  description: true,
  status: true,
  receiptKey: true,
  submittedAt: true,
  resolvedAt: true,
  reimbursedAt: true,
  version: true,
  employee: { select: { id: true, firstName: true, lastName: true } },
  category: { select: { id: true, name: true, code: true } },
  project: { select: { id: true, key: true, name: true } },
} as const;

async function requireOwnEmployee(organizationId: string, userId: string) {
  const employee = await prisma.employee.findFirst({
    where: { organizationId, userId },
    select: { id: true },
  });
  if (!employee) {
    throw new BusinessRuleError(
      'Your account is not linked to an employee record, so you cannot file claims.',
    );
  }
  return employee;
}

export function expenseRoutes(app: FastifyInstance, _opts: unknown, done: () => void): void {
  /**
   * GET /v1/expenses
   *
   * Scope depends on permission, not on a client flag. Holding only
   * `expense.read_self` restricts the query to your own claims regardless of
   * what filters were sent — the alternative is trusting `?mine=true`, which is
   * trusting the caller to police themselves.
   */
  app.get(
    '/v1/expenses',
    { preHandler: app.requirePermission('expense.read_self') },
    async (request) => {
      const query = expenseQuerySchema.parse(request.query);
      const { organizationId, permissions } = request.membership!;
      const canSeeOthers = permissions.has('expense.read');

      const me = await prisma.employee.findFirst({
        where: { organizationId, userId: request.auth!.userId },
        select: { id: true },
      });

      // Forced, not defaulted.
      const employeeFilter = canSeeOthers
        ? definedOnly({ employeeId: query.mine ? me?.id : query.employeeId })
        : { employeeId: me?.id ?? '00000000-0000-0000-0000-000000000000' };

      const rows = await prisma.expense.findMany({
        where: {
          organizationId,
          ...employeeFilter,
          ...definedOnly({ status: query.status, categoryId: query.categoryId }),
        },
        select: expenseSelect,
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

  /** POST /v1/expenses — creates a DRAFT. */
  app.post(
    '/v1/expenses',
    { preHandler: app.requirePermission('expense.create') },
    async (request, reply) => {
      const input = createExpenseSchema.parse(request.body);
      const { organizationId } = request.membership!;
      const me = await requireOwnEmployee(organizationId, request.auth!.userId);

      const category = await prisma.expenseCategory.findFirst({
        where: { id: input.categoryId, organizationId },
        select: { id: true, name: true, receiptRequiredAbove: true },
      });
      if (!category) throw new NotFoundError('Expense category');

      if (
        category.receiptRequiredAbove &&
        Number(input.amount) > Number(category.receiptRequiredAbove) &&
        !input.receiptKey
      ) {
        throw new BusinessRuleError(
          `${category.name} claims above ${category.receiptRequiredAbove} need a receipt.`,
        );
      }

      // A claim dated in the future is almost always a typo.
      if (input.spentOn > new Date().toISOString().slice(0, 10)) {
        throw new BusinessRuleError('The spend date cannot be in the future.');
      }

      const expense = await prisma.expense.create({
        data: {
          organizationId,
          employeeId: me.id,
          categoryId: input.categoryId,
          amount: input.amount,
          currency: input.currency,
          spentOn: new Date(input.spentOn),
          description: input.description,
          ...definedOnly({
            projectId: input.projectId ?? undefined,
            receiptKey: input.receiptKey,
          }),
        },
        select: expenseSelect,
      });

      return reply.status(201).send(serialize(expense));
    },
  );

  /** PATCH /v1/expenses/:expenseId — only while DRAFT. */
  app.patch(
    '/v1/expenses/:expenseId',
    { preHandler: app.requirePermission('expense.create') },
    async (request) => {
      const { expenseId } = idParam.parse(request.params);
      const input = updateExpenseSchema.parse(request.body);
      const { organizationId } = request.membership!;
      const me = await requireOwnEmployee(organizationId, request.auth!.userId);

      const before = await prisma.expense.findFirst({
        where: { id: expenseId, organizationId },
        select: { employeeId: true, status: true, amount: true, description: true },
      });
      if (!before) throw new NotFoundError('Expense');
      if (before.employeeId !== me.id) {
        throw new ForbiddenError('You can only edit your own claims.');
      }
      // Editing a submitted claim would change what approvers already saw.
      if (before.status !== 'DRAFT') {
        throw new BusinessRuleError(
          `A ${before.status.toLowerCase()} claim cannot be edited. Withdraw it first.`,
        );
      }

      const { version, spentOn, ...rest } = input;
      const changes = definedOnly({
        ...rest,
        ...(spentOn !== undefined ? { spentOn: new Date(spentOn) } : {}),
      });

      return prisma.$transaction(async (tx) => {
        const result = await tx.expense.updateMany({
          where: { id: expenseId, organizationId, version },
          data: { ...changes, version: { increment: 1 } },
        });
        if (result.count === 0) throw new VersionConflictError(version);

        await record(tx, {
          organizationId,
          actorId: request.auth!.userId,
          action: 'expense.updated',
          entityType: 'expense',
          entityId: expenseId,
          metadata: { changes: diff(before, changes) },
          ipAddress: request.ip,
          requestId: request.id,
        });

        const fresh = await tx.expense.findUniqueOrThrow({
          where: { id: expenseId },
          select: expenseSelect,
        });
        return serialize(fresh);
      });
    },
  );

  /**
   * POST /v1/expenses/:expenseId/submit
   *
   * The handoff. Status change and approval creation happen in one transaction:
   * a SUBMITTED expense with no approval request would sit in a queue nobody
   * can see.
   */
  app.post(
    '/v1/expenses/:expenseId/submit',
    { preHandler: app.requirePermission('expense.create') },
    async (request) => {
      const { expenseId } = idParam.parse(request.params);
      const { organizationId } = request.membership!;
      const auth = request.auth!;
      const me = await requireOwnEmployee(organizationId, auth.userId);

      const expense = await prisma.expense.findFirst({
        where: { id: expenseId, organizationId },
        select: { id: true, employeeId: true, status: true, amount: true, currency: true },
      });
      if (!expense) throw new NotFoundError('Expense');
      if (expense.employeeId !== me.id) {
        throw new ForbiddenError('You can only submit your own claims.');
      }

      const check = expenseStateMachine.check(expense.status, 'SUBMITTED');
      if (!check.ok) {
        throw new InvalidStateTransitionError(expense.status, 'SUBMITTED', check.allowed);
      }

      return prisma.$transaction(async (tx) => {
        await tx.expense.update({
          where: { id: expenseId },
          data: { status: 'SUBMITTED', submittedAt: new Date(), version: { increment: 1 } },
        });

        const approval = await submitForApproval(tx, {
          organizationId,
          entityType: 'EXPENSE',
          entityId: expenseId,
          requesterId: me.id,
          amount: Number(expense.amount),
          currency: expense.currency,
          actorUserId: auth.userId,
          requestId: request.id,
          ipAddress: request.ip,
        });

        // A policy that resolved to nothing actionable approves immediately;
        // the expense must follow, not linger as SUBMITTED forever.
        if (approval.status === 'APPROVED') {
          await tx.expense.update({
            where: { id: expenseId },
            data: { status: 'APPROVED', resolvedAt: new Date(), version: { increment: 1 } },
          });
        }

        return {
          expenseId,
          status: approval.status === 'APPROVED' ? 'APPROVED' : 'SUBMITTED',
          approvalRequestId: approval.approvalRequestId,
          awaiting: approval.pendingStepName,
        };
      });
    },
  );

  /** POST /v1/expenses/:expenseId/withdraw — back to DRAFT, cancelling approval. */
  app.post(
    '/v1/expenses/:expenseId/withdraw',
    { preHandler: app.requirePermission('expense.create') },
    async (request) => {
      const { expenseId } = idParam.parse(request.params);
      const { organizationId } = request.membership!;
      const me = await requireOwnEmployee(organizationId, request.auth!.userId);

      const expense = await prisma.expense.findFirst({
        where: { id: expenseId, organizationId, employeeId: me.id },
        select: { status: true },
      });
      if (!expense) throw new NotFoundError('Expense');
      if (expense.status !== 'SUBMITTED') {
        throw new BusinessRuleError('Only a submitted claim can be withdrawn.');
      }

      return prisma.$transaction(async (tx) => {
        await cancel(tx, organizationId, 'EXPENSE', expenseId);
        await tx.expense.update({
          where: { id: expenseId },
          data: { status: 'DRAFT', submittedAt: null, version: { increment: 1 } },
        });
        return { expenseId, status: 'DRAFT' };
      });
    },
  );

  /**
   * POST /v1/expenses/:expenseId/reimburse
   *
   * Separate from approval, and gated on `expense.reimburse` — approving a
   * claim and paying it are different acts by different people. Only Finance
   * and Owner hold this.
   */
  app.post(
    '/v1/expenses/:expenseId/reimburse',
    { preHandler: app.requirePermission('expense.reimburse') },
    async (request) => {
      const { expenseId } = idParam.parse(request.params);
      const { organizationId } = request.membership!;

      const expense = await prisma.expense.findFirst({
        where: { id: expenseId, organizationId },
        select: { status: true, amount: true, currency: true },
      });
      if (!expense) throw new NotFoundError('Expense');

      const check = expenseStateMachine.check(expense.status, 'REIMBURSED');
      if (!check.ok) {
        throw new InvalidStateTransitionError(expense.status, 'REIMBURSED', check.allowed);
      }

      return prisma.$transaction(async (tx) => {
        await tx.expense.update({
          where: { id: expenseId },
          data: { status: 'REIMBURSED', reimbursedAt: new Date(), version: { increment: 1 } },
        });

        await record(tx, {
          organizationId,
          actorId: request.auth!.userId,
          action: 'expense.reimbursed',
          entityType: 'expense',
          entityId: expenseId,
          metadata: { amount: expense.amount.toString(), currency: expense.currency },
          ipAddress: request.ip,
          requestId: request.id,
        });

        return { expenseId, status: 'REIMBURSED' };
      });
    },
  );

  /** GET /v1/expense-categories */
  app.get(
    '/v1/expense-categories',
    { preHandler: app.requirePermission('expense.read_self') },
    async (request) => {
      const categories = await prisma.expenseCategory.findMany({
        where: { organizationId: request.membership!.organizationId },
        select: { id: true, name: true, code: true, receiptRequiredAbove: true },
        orderBy: { name: 'asc' },
      });
      return {
        data: categories.map((c) => ({
          ...c,
          receiptRequiredAbove: c.receiptRequiredAbove?.toString() ?? null,
        })),
      };
    },
  );

  /** POST /v1/expense-categories */
  app.post(
    '/v1/expense-categories',
    { preHandler: app.requirePermission('expense.approve') },
    async (request, reply) => {
      const input = createExpenseCategorySchema.parse(request.body);
      const { organizationId } = request.membership!;

      const category = await prisma.expenseCategory.create({
        data: {
          organizationId,
          name: input.name,
          code: input.code,
          receiptRequiredAbove: input.receiptRequiredAbove ?? null,
        },
        select: { id: true, name: true, code: true },
      });
      return reply.status(201).send(category);
    },
  );

  done();
}

function serialize<
  T extends { amount: { toString(): string }; spentOn: Date; submittedAt: Date | null },
>(expense: T) {
  return {
    ...expense,
    // Decimal -> string, never a JS number (Section 28.2).
    amount: expense.amount.toString(),
    spentOn: expense.spentOn.toISOString().slice(0, 10),
    submittedAt: expense.submittedAt?.toISOString() ?? null,
  };
}
