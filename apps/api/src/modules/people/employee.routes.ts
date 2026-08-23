import {
  BusinessRuleError,
  ConflictError,
  ERROR_CODES,
  NotFoundError,
  VersionConflictError,
  buildPage,
  createEmployeeSchema,
  employeeQuerySchema,
  toPrismaPageArgs,
  updateEmployeeSchema,
} from '@businessos/contracts';
import {
  ancestorsOf,
  buildChildrenMap,
  descendantsOf,
  wouldCreateCycle,
  type ParentMap,
} from '@businessos/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { diff, record } from '../../lib/audit.js';
import { definedOnly } from '../../lib/defined.js';
import { prisma } from '../../lib/prisma.js';

/**
 * Employees — the People directory and the reporting line.
 *
 * `managerId` is a self-referencing edge, so the reporting structure is a tree
 * and the same cycle rule applies as for departments: a manager must not end up
 * reporting to their own report. See `wouldCreateCycle`.
 */

const idParam = z.object({ employeeId: z.string().uuid() });

const employeeSelect = {
  id: true,
  employeeCode: true,
  firstName: true,
  lastName: true,
  workEmail: true,
  designation: true,
  employmentType: true,
  status: true,
  workMode: true,
  location: true,
  joinedOn: true,
  department: { select: { id: true, name: true, code: true } },
  manager: { select: { id: true, firstName: true, lastName: true } },
} as const;

/** `employee -> manager` for one tenant, for the cycle check. */
async function loadReportingMap(organizationId: string): Promise<ParentMap> {
  const rows = await prisma.employee.findMany({
    where: { organizationId },
    select: { id: true, managerId: true },
  });
  return new Map(rows.map((r) => [r.id, r.managerId]));
}

/** Next free sequential code for a department, e.g. ENG-014. */
async function nextEmployeeCode(organizationId: string, departmentCode: string): Promise<string> {
  const count = await prisma.employee.count({
    where: { organizationId, employeeCode: { startsWith: `${departmentCode}-` } },
  });
  // The unique constraint on (organizationId, employeeCode) remains the real
  // guarantee; a concurrent create can still collide and surface as a 409.
  return `${departmentCode}-${String(count + 1).padStart(3, '0')}`;
}

export function employeeRoutes(app: FastifyInstance, _opts: unknown, done: () => void): void {
  /**
   * GET /v1/employees — the directory.
   *
   * The first endpoint using cursor pagination (Section 16.1). Offset would get
   * linearly slower with depth and would skip or repeat rows whenever someone
   * is hired mid-scroll; a keyset cursor on the UUIDv7 id is a stable range
   * scan on an index the query already uses.
   */
  app.get(
    '/v1/employees',
    { preHandler: app.requirePermission('employee.read') },
    async (request) => {
      const query = employeeQuerySchema.parse(request.query);
      const { organizationId } = request.membership!;

      const pageArgs = toPrismaPageArgs(query);

      const rows = await prisma.employee.findMany({
        where: {
          organizationId,
          ...definedOnly({
            departmentId: query.departmentId,
            managerId: query.managerId,
            status: query.status,
            employmentType: query.employmentType,
          }),
          // Search across the fields a person would actually type. PostgreSQL
          // ILIKE for now; Section 16.2 says move to full-text or a search
          // service only when this stops being enough.
          ...(query.q
            ? {
                OR: [
                  { firstName: { contains: query.q, mode: 'insensitive' as const } },
                  { lastName: { contains: query.q, mode: 'insensitive' as const } },
                  { workEmail: { contains: query.q, mode: 'insensitive' as const } },
                  { employeeCode: { contains: query.q, mode: 'insensitive' as const } },
                  { designation: { contains: query.q, mode: 'insensitive' as const } },
                ],
              }
            : {}),
        },
        select: employeeSelect,
        // Ascending by id, which for UUIDv7 is ascending by creation time.
        orderBy: { id: 'asc' },
        ...pageArgs,
      });

      const page = buildPage(rows, query.limit);
      return {
        data: page.data.map(serialize),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      };
    },
  );

  /** GET /v1/employees/:employeeId */
  app.get(
    '/v1/employees/:employeeId',
    { preHandler: app.requirePermission('employee.read') },
    async (request) => {
      const { employeeId } = idParam.parse(request.params);
      const { organizationId } = request.membership!;

      const employee = await prisma.employee.findFirst({
        // organizationId in the filter, not just the id: without it any valid
        // employee id from another tenant would be readable here.
        where: { id: employeeId, organizationId },
        select: {
          ...employeeSelect,
          personalEmail: true,
          phone: true,
          exitedOn: true,
          version: true,
          createdAt: true,
          user: { select: { id: true, email: true, lastLoginAt: true } },
          reports: {
            select: { id: true, firstName: true, lastName: true, designation: true },
            orderBy: { firstName: 'asc' },
          },
        },
      });
      if (!employee) throw new NotFoundError('Employee');

      // The chain to the top, nearest manager first (Section 26.1).
      const parents = await loadReportingMap(organizationId);
      const chainIds = ancestorsOf(employeeId, parents);
      const chain = chainIds.length
        ? await prisma.employee.findMany({
            where: { id: { in: chainIds }, organizationId },
            select: { id: true, firstName: true, lastName: true, designation: true },
          })
        : [];

      return {
        ...serialize(employee),
        personalEmail: employee.personalEmail,
        phone: employee.phone,
        exitedOn: employee.exitedOn?.toISOString().slice(0, 10) ?? null,
        version: employee.version,
        account: employee.user,
        reports: employee.reports,
        // Re-ordered to match the walk, since `findMany` returns index order.
        reportingChain: chainIds
          .map((id) => chain.find((c) => c.id === id))
          .filter((c): c is NonNullable<typeof c> => Boolean(c)),
      };
    },
  );

  /** POST /v1/employees */
  app.post(
    '/v1/employees',
    { preHandler: app.requirePermission('employee.create') },
    async (request, reply) => {
      const input = createEmployeeSchema.parse(request.body);
      const { organizationId } = request.membership!;
      const auth = request.auth!;

      let departmentCode = 'EMP';
      if (input.departmentId) {
        const department = await prisma.department.findFirst({
          where: { id: input.departmentId, organizationId },
          select: { code: true },
        });
        if (!department) throw new NotFoundError('Department');
        departmentCode = department.code;
      }

      if (input.managerId) {
        const manager = await prisma.employee.findFirst({
          where: { id: input.managerId, organizationId },
          select: { id: true },
        });
        if (!manager) throw new NotFoundError('Manager');
      }

      const employeeCode =
        input.employeeCode ?? (await nextEmployeeCode(organizationId, departmentCode));

      const duplicate = await prisma.employee.findFirst({
        where: {
          organizationId,
          OR: [{ employeeCode }, { workEmail: input.workEmail }],
        },
        select: { employeeCode: true, workEmail: true },
      });
      if (duplicate) {
        throw new ConflictError(
          duplicate.workEmail === input.workEmail
            ? 'An employee with that work email already exists.'
            : `Employee code ${employeeCode} is already in use.`,
          ERROR_CODES.DUPLICATE_RESOURCE,
        );
      }

      const employee = await prisma.$transaction(async (tx) => {
        const created = await tx.employee.create({
          data: {
            organizationId,
            employeeCode,
            firstName: input.firstName,
            lastName: input.lastName,
            workEmail: input.workEmail,
            designation: input.designation,
            employmentType: input.employmentType,
            workMode: input.workMode,
            joinedOn: new Date(input.joinedOn),
            ...definedOnly({
              personalEmail: input.personalEmail,
              phone: input.phone,
              location: input.location,
              departmentId: input.departmentId ?? undefined,
              managerId: input.managerId ?? undefined,
              userId: input.userId ?? undefined,
            }),
          },
          select: employeeSelect,
        });

        await record(tx, {
          organizationId,
          actorId: auth.userId,
          action: 'employee.created',
          entityType: 'employee',
          entityId: created.id,
          metadata: { employeeCode, workEmail: input.workEmail, designation: input.designation },
          ipAddress: request.ip,
          requestId: request.id,
        });

        return created;
      });

      return reply.status(201).send(serialize(employee));
    },
  );

  /** PATCH /v1/employees/:employeeId */
  app.patch(
    '/v1/employees/:employeeId',
    { preHandler: app.requirePermission('employee.update') },
    async (request) => {
      const { employeeId } = idParam.parse(request.params);
      const input = updateEmployeeSchema.parse(request.body);
      const { organizationId } = request.membership!;
      const auth = request.auth!;

      const before = await prisma.employee.findFirst({
        where: { id: employeeId, organizationId },
        select: {
          firstName: true,
          lastName: true,
          designation: true,
          status: true,
          departmentId: true,
          managerId: true,
          version: true,
        },
      });
      if (!before) throw new NotFoundError('Employee');

      if (input.departmentId) {
        const department = await prisma.department.findFirst({
          where: { id: input.departmentId, organizationId },
          select: { id: true },
        });
        if (!department) throw new NotFoundError('Department');
      }

      if (input.managerId !== undefined) {
        if (input.managerId !== null) {
          const manager = await prisma.employee.findFirst({
            where: { id: input.managerId, organizationId },
            select: { id: true },
          });
          if (!manager) throw new NotFoundError('Manager');
        }

        // "A reports to B, B reports to A" — invisible to the foreign key, and
        // fatal to every later walk of the reporting line.
        const reporting = await loadReportingMap(organizationId);
        if (wouldCreateCycle(employeeId, input.managerId, reporting)) {
          throw new BusinessRuleError(
            'That reporting line loops back on itself.',
            ERROR_CODES.BUSINESS_RULE_VIOLATION,
            { employeeId, proposedManagerId: input.managerId },
          );
        }
      }

      const { version, exitedOn, ...rest } = input;
      const changes = definedOnly({
        ...rest,
        ...(exitedOn !== undefined
          ? { exitedOn: exitedOn === null ? null : new Date(exitedOn) }
          : {}),
      });

      const updated = await prisma.$transaction(async (tx) => {
        // updateMany reports a row count, which is what makes the version guard
        // work: `update` would throw not-found and hide the real cause.
        const result = await tx.employee.updateMany({
          where: { id: employeeId, organizationId, version },
          data: { ...changes, version: { increment: 1 } },
        });
        if (result.count === 0) throw new VersionConflictError(version);

        const fresh = await tx.employee.findUniqueOrThrow({
          where: { id: employeeId },
          select: { ...employeeSelect, version: true },
        });

        await record(tx, {
          organizationId,
          actorId: auth.userId,
          action: 'employee.updated',
          entityType: 'employee',
          entityId: employeeId,
          metadata: { changes: diff(before, changes) },
          ipAddress: request.ip,
          requestId: request.id,
        });

        return fresh;
      });

      return { ...serialize(updated), version: updated.version };
    },
  );

  /**
   * GET /v1/employees/:employeeId/team
   *
   * Everyone beneath this person, breadth-first (Section 26.1). BFS rather than
   * DFS because "nearest reports first" is how a manager reads their own team.
   */
  app.get(
    '/v1/employees/:employeeId/team',
    { preHandler: app.requirePermission('employee.read') },
    async (request) => {
      const { employeeId } = idParam.parse(request.params);
      const { organizationId } = request.membership!;

      const exists = await prisma.employee.findFirst({
        where: { id: employeeId, organizationId },
        select: { id: true },
      });
      if (!exists) throw new NotFoundError('Employee');

      const reporting = await loadReportingMap(organizationId);
      const ids = descendantsOf(employeeId, buildChildrenMap(reporting));

      if (ids.length === 0) return { data: [], total: 0 };

      const team = await prisma.employee.findMany({
        where: { id: { in: ids }, organizationId },
        select: employeeSelect,
      });

      // Restore BFS order: findMany returns index order, not traversal order.
      const byId = new Map(team.map((t) => [t.id, t]));
      return {
        data: ids
          .map((id) => byId.get(id))
          .filter(Boolean)
          .map((e) => serialize(e!)),
        total: ids.length,
      };
    },
  );

  done();
}

/** Dates cross the wire as YYYY-MM-DD, never as a timezone-bearing ISO stamp. */
function serialize<T extends { joinedOn: Date }>(employee: T) {
  return { ...employee, joinedOn: employee.joinedOn.toISOString().slice(0, 10) };
}
