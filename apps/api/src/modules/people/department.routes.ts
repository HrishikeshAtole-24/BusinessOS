import {
  BusinessRuleError,
  ConflictError,
  ERROR_CODES,
  NotFoundError,
  createDepartmentSchema,
  updateDepartmentSchema,
  type DepartmentNode,
} from '@businessos/contracts';
import { buildTree, wouldCreateCycle, type ParentMap } from '@businessos/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { diff, record } from '../../lib/audit.js';
import { definedOnly } from '../../lib/defined.js';
import { prisma } from '../../lib/prisma.js';

/**
 * Departments — a per-tenant tree (report Section 26.1).
 *
 * The interesting constraint here is one PostgreSQL cannot express: a
 * department must not become its own ancestor. `parent_id` guarantees the
 * parent exists; it says nothing about reachability. So every re-parent loads
 * the tenant's edges and checks with `wouldCreateCycle` before writing.
 */

const idParam = z.object({ departmentId: z.string().uuid() });

/**
 * Load `child -> parent` for one tenant.
 *
 * Deliberately scoped by organizationId, which is both the tenant boundary and
 * the reason this is cheap: a tenant has tens of departments, not millions, so
 * one indexed read beats a recursive CTE per check and keeps the cycle rule in
 * testable application code rather than in SQL.
 */
async function loadParentMap(organizationId: string): Promise<ParentMap> {
  const rows = await prisma.department.findMany({
    where: { organizationId },
    select: { id: true, parentId: true },
  });
  return new Map(rows.map((r) => [r.id, r.parentId]));
}

export function departmentRoutes(app: FastifyInstance, _opts: unknown, done: () => void): void {
  /**
   * GET /v1/departments — the whole tree, nested.
   *
   * Returned nested rather than flat because the shape IS the information: a
   * client that had to reassemble it would reimplement `buildTree`, probably
   * as an O(n²) filter-per-node.
   */
  app.get(
    '/v1/departments',
    { preHandler: app.requirePermission('department.read') },
    async (request) => {
      const { organizationId } = request.membership!;

      const departments = await prisma.department.findMany({
        where: { organizationId },
        select: {
          id: true,
          name: true,
          code: true,
          description: true,
          parentId: true,
          head: { select: { id: true, firstName: true, lastName: true } },
          _count: { select: { employees: true } },
        },
        orderBy: { name: 'asc' },
      });

      const roots = buildTree(
        departments.map((d) => ({ id: d.id, parentId: d.parentId, source: d })),
      );

      function toNode(node: (typeof roots)[number]): DepartmentNode {
        const source = node.value.source;
        return {
          id: source.id,
          name: source.name,
          code: source.code,
          description: source.description,
          parentId: source.parentId,
          headcount: source._count.employees,
          depth: node.depth,
          children: node.children.map(toNode),
        };
      }

      return { data: roots.map(toNode), total: departments.length };
    },
  );

  /** POST /v1/departments */
  app.post(
    '/v1/departments',
    { preHandler: app.requirePermission('department.manage') },
    async (request, reply) => {
      const input = createDepartmentSchema.parse(request.body);
      const { organizationId } = request.membership!;
      const auth = request.auth!;

      if (input.parentId) {
        // Scoped by organizationId: a valid department id from another tenant
        // must not be attachable here.
        const parent = await prisma.department.findFirst({
          where: { id: input.parentId, organizationId },
          select: { id: true },
        });
        if (!parent) throw new NotFoundError('Parent department');
      }

      const existing = await prisma.department.findUnique({
        where: { organizationId_code: { organizationId, code: input.code } },
        select: { id: true },
      });
      if (existing) {
        throw new ConflictError(
          `A department with code ${input.code} already exists.`,
          ERROR_CODES.DUPLICATE_RESOURCE,
        );
      }

      const department = await prisma.$transaction(async (tx) => {
        const created = await tx.department.create({
          data: {
            organizationId,
            name: input.name,
            code: input.code,
            ...definedOnly({
              description: input.description,
              parentId: input.parentId ?? undefined,
              headId: input.headId ?? undefined,
            }),
          },
          select: { id: true, name: true, code: true, parentId: true },
        });

        await record(tx, {
          organizationId,
          actorId: auth.userId,
          action: 'department.created',
          entityType: 'department',
          entityId: created.id,
          metadata: { name: created.name, code: created.code },
          ipAddress: request.ip,
          requestId: request.id,
        });

        return created;
      });

      return reply.status(201).send(department);
    },
  );

  /** PATCH /v1/departments/:departmentId */
  app.patch(
    '/v1/departments/:departmentId',
    { preHandler: app.requirePermission('department.manage') },
    async (request) => {
      const { departmentId } = idParam.parse(request.params);
      const input = updateDepartmentSchema.parse(request.body);
      const { organizationId } = request.membership!;
      const auth = request.auth!;

      const before = await prisma.department.findFirst({
        where: { id: departmentId, organizationId },
        select: { name: true, description: true, parentId: true, headId: true },
      });
      if (!before) throw new NotFoundError('Department');

      if (input.parentId !== undefined) {
        if (input.parentId !== null) {
          const parent = await prisma.department.findFirst({
            where: { id: input.parentId, organizationId },
            select: { id: true },
          });
          if (!parent) throw new NotFoundError('Parent department');
        }

        /**
         * The check the database cannot do. Without it, "Engineering reports to
         * Payments" (already under Engineering) creates a loop, and every later
         * traversal of the tree spins forever.
         */
        const parents = await loadParentMap(organizationId);
        if (wouldCreateCycle(departmentId, input.parentId, parents)) {
          throw new BusinessRuleError(
            'That would place the department inside itself.',
            ERROR_CODES.BUSINESS_RULE_VIOLATION,
            { departmentId, proposedParentId: input.parentId },
          );
        }
      }

      const changes = definedOnly({
        name: input.name,
        description: input.description,
        parentId: input.parentId,
        headId: input.headId,
      });

      const updated = await prisma.$transaction(async (tx) => {
        const result = await tx.department.update({
          where: { id: departmentId },
          data: changes,
          select: { id: true, name: true, code: true, parentId: true, description: true },
        });

        await record(tx, {
          organizationId,
          actorId: auth.userId,
          action: 'department.updated',
          entityType: 'department',
          entityId: departmentId,
          metadata: { changes: diff(before, changes) },
          ipAddress: request.ip,
          requestId: request.id,
        });

        return result;
      });

      return updated;
    },
  );

  /**
   * DELETE /v1/departments/:departmentId
   *
   * Refused while the department still has children or employees. Cascading
   * would silently delete a subtree, and `SetNull` on employees would quietly
   * strand people with no department — both are worse than making the caller
   * move things first.
   */
  app.delete(
    '/v1/departments/:departmentId',
    { preHandler: app.requirePermission('department.manage') },
    async (request, reply) => {
      const { departmentId } = idParam.parse(request.params);
      const { organizationId } = request.membership!;

      const department = await prisma.department.findFirst({
        where: { id: departmentId, organizationId },
        select: {
          name: true,
          _count: { select: { children: true, employees: true } },
        },
      });
      if (!department) throw new NotFoundError('Department');

      if (department._count.children > 0) {
        throw new BusinessRuleError(
          `Move or delete the ${department._count.children} sub-department(s) first.`,
        );
      }
      if (department._count.employees > 0) {
        throw new BusinessRuleError(
          `Reassign the ${department._count.employees} employee(s) in this department first.`,
        );
      }

      await prisma.$transaction(async (tx) => {
        await tx.department.delete({ where: { id: departmentId } });
        await record(tx, {
          organizationId,
          actorId: request.auth!.userId,
          action: 'department.deleted',
          entityType: 'department',
          entityId: departmentId,
          metadata: { name: department.name },
          ipAddress: request.ip,
          requestId: request.id,
        });
      });

      return reply.status(204).send();
    },
  );

  done();
}
