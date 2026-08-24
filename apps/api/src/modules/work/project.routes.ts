import {
  BusinessRuleError,
  ConflictError,
  ERROR_CODES,
  InvalidStateTransitionError,
  NotFoundError,
  VersionConflictError,
  addProjectMemberSchema,
  buildPage,
  createProjectSchema,
  projectQuerySchema,
  toPrismaPageArgs,
  updateProjectSchema,
  type ProjectSchedule,
} from '@businessos/contracts';
import {
  blockedBy,
  buildAdjacency,
  criticalPath,
  isTaskComplete,
  projectStateMachine,
  readyNodes,
  topologicalSort,
  type Edge,
} from '@businessos/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { diff, record } from '../../lib/audit.js';
import { definedOnly } from '../../lib/defined.js';
import { prisma } from '../../lib/prisma.js';

const idParam = z.object({ projectId: z.string().uuid() });

export function projectRoutes(app: FastifyInstance, _opts: unknown, done: () => void): void {
  /** GET /v1/projects */
  app.get(
    '/v1/projects',
    { preHandler: app.requirePermission('project.read') },
    async (request) => {
      const query = projectQuerySchema.parse(request.query);
      const { organizationId } = request.membership!;

      const rows = await prisma.project.findMany({
        where: {
          organizationId,
          ...definedOnly({ status: query.status }),
          ...(query.q
            ? {
                OR: [
                  { name: { contains: query.q, mode: 'insensitive' as const } },
                  { key: { contains: query.q, mode: 'insensitive' as const } },
                ],
              }
            : {}),
        },
        select: {
          id: true,
          name: true,
          key: true,
          status: true,
          priority: true,
          startDate: true,
          dueDate: true,
          budgetAmount: true,
          budgetCurrency: true,
          owner: { select: { id: true, firstName: true, lastName: true } },
          _count: { select: { tasks: true, members: true } },
          tasks: { where: { status: 'DONE' }, select: { id: true } },
        },
        orderBy: { id: 'asc' },
        ...toPrismaPageArgs(query),
      });

      const page = buildPage(rows, query.limit);
      return {
        data: page.data.map((p) => ({
          id: p.id,
          name: p.name,
          key: p.key,
          status: p.status,
          priority: p.priority,
          startDate: date(p.startDate),
          dueDate: date(p.dueDate),
          // Decimal -> string, never a JS number (Section 28.2).
          budgetAmount: p.budgetAmount?.toString() ?? null,
          budgetCurrency: p.budgetCurrency,
          owner: p.owner,
          taskCount: p._count.tasks,
          doneCount: p.tasks.length,
          memberCount: p._count.members,
        })),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      };
    },
  );

  /** POST /v1/projects */
  app.post(
    '/v1/projects',
    { preHandler: app.requirePermission('project.create') },
    async (request, reply) => {
      const input = createProjectSchema.parse(request.body);
      const { organizationId } = request.membership!;

      const clash = await prisma.project.findUnique({
        where: { organizationId_key: { organizationId, key: input.key } },
        select: { id: true },
      });
      if (clash) {
        throw new ConflictError(
          `Project key ${input.key} is already in use.`,
          ERROR_CODES.DUPLICATE_RESOURCE,
        );
      }

      if (input.startDate && input.dueDate && input.dueDate < input.startDate) {
        throw new BusinessRuleError('The due date cannot be before the start date.');
      }

      const project = await prisma.$transaction(async (tx) => {
        const created = await tx.project.create({
          data: {
            organizationId,
            name: input.name,
            key: input.key,
            priority: input.priority,
            ...definedOnly({
              description: input.description,
              startDate: input.startDate ? new Date(input.startDate) : undefined,
              dueDate: input.dueDate ? new Date(input.dueDate) : undefined,
              budgetAmount: input.budgetAmount,
              budgetCurrency: input.budgetCurrency,
              ownerId: input.ownerId ?? undefined,
            }),
          },
          select: { id: true, name: true, key: true, status: true },
        });

        await record(tx, {
          organizationId,
          actorId: request.auth!.userId,
          action: 'project.created',
          entityType: 'project',
          entityId: created.id,
          metadata: { name: created.name, key: created.key },
          ipAddress: request.ip,
          requestId: request.id,
        });

        return created;
      });

      return reply.status(201).send(project);
    },
  );

  /** GET /v1/projects/:projectId */
  app.get(
    '/v1/projects/:projectId',
    { preHandler: app.requirePermission('project.read') },
    async (request) => {
      const { projectId } = idParam.parse(request.params);
      const { organizationId } = request.membership!;

      const project = await prisma.project.findFirst({
        where: { id: projectId, organizationId },
        select: {
          id: true,
          name: true,
          key: true,
          description: true,
          status: true,
          priority: true,
          startDate: true,
          dueDate: true,
          budgetAmount: true,
          budgetCurrency: true,
          version: true,
          createdAt: true,
          owner: { select: { id: true, firstName: true, lastName: true } },
          members: {
            select: {
              role: true,
              employee: {
                select: { id: true, firstName: true, lastName: true, designation: true },
              },
            },
          },
          _count: { select: { tasks: true } },
        },
      });
      if (!project) throw new NotFoundError('Project');

      return {
        ...project,
        startDate: date(project.startDate),
        dueDate: date(project.dueDate),
        budgetAmount: project.budgetAmount?.toString() ?? null,
        allowedTransitions: projectStateMachine.allowedFrom(project.status),
      };
    },
  );

  /** PATCH /v1/projects/:projectId */
  app.patch(
    '/v1/projects/:projectId',
    { preHandler: app.requirePermission('project.manage') },
    async (request) => {
      const { projectId } = idParam.parse(request.params);
      const input = updateProjectSchema.parse(request.body);
      const { organizationId } = request.membership!;

      const before = await prisma.project.findFirst({
        where: { id: projectId, organizationId },
        select: { name: true, status: true, priority: true, ownerId: true, version: true },
      });
      if (!before) throw new NotFoundError('Project');

      // Section 8: the transition table decides, not a scattered if-chain.
      if (input.status && input.status !== before.status) {
        const check = projectStateMachine.check(before.status, input.status);
        if (!check.ok) {
          throw new InvalidStateTransitionError(before.status, input.status, check.allowed);
        }
      }

      const { version, startDate, dueDate, ...rest } = input;
      const changes = definedOnly({
        ...rest,
        ...(startDate !== undefined
          ? { startDate: startDate === null ? null : new Date(startDate) }
          : {}),
        ...(dueDate !== undefined ? { dueDate: dueDate === null ? null : new Date(dueDate) } : {}),
      });

      return prisma.$transaction(async (tx) => {
        const result = await tx.project.updateMany({
          where: { id: projectId, organizationId, version },
          data: { ...changes, version: { increment: 1 } },
        });
        if (result.count === 0) throw new VersionConflictError(version);

        const fresh = await tx.project.findUniqueOrThrow({
          where: { id: projectId },
          select: { id: true, name: true, key: true, status: true, priority: true, version: true },
        });

        await record(tx, {
          organizationId,
          actorId: request.auth!.userId,
          action: 'project.updated',
          entityType: 'project',
          entityId: projectId,
          metadata: { changes: diff(before, changes) },
          ipAddress: request.ip,
          requestId: request.id,
        });

        return fresh;
      });
    },
  );

  /** POST /v1/projects/:projectId/members */
  app.post(
    '/v1/projects/:projectId/members',
    { preHandler: app.requirePermission('project.manage') },
    async (request, reply) => {
      const { projectId } = idParam.parse(request.params);
      const input = addProjectMemberSchema.parse(request.body);
      const { organizationId } = request.membership!;

      const [project, employee] = await Promise.all([
        prisma.project.findFirst({
          where: { id: projectId, organizationId },
          select: { id: true },
        }),
        prisma.employee.findFirst({
          where: { id: input.employeeId, organizationId },
          select: { id: true },
        }),
      ]);
      if (!project) throw new NotFoundError('Project');
      if (!employee) throw new NotFoundError('Employee');

      await prisma.projectMember.upsert({
        where: { projectId_employeeId: { projectId, employeeId: input.employeeId } },
        update: { role: input.role },
        create: { projectId, employeeId: input.employeeId, role: input.role },
      });

      return reply.status(201).send({ projectId, employeeId: input.employeeId, role: input.role });
    },
  );

  /**
   * GET /v1/projects/:projectId/schedule
   *
   * Where the graph algorithms surface as a product feature (Section 26.1).
   *
   *   order         Kahn's topological sort — a valid execution sequence
   *   criticalPath  longest weighted chain, i.e. what actually sets the end date
   *   ready         nothing blocking these; they can start now
   *   blocked       waiting, with the specific tasks they wait on
   *
   * All four come from one read of the task list and its edges, and each is
   * O(V + E).
   */
  app.get(
    '/v1/projects/:projectId/schedule',
    { preHandler: app.requirePermission('project.read') },
    async (request) => {
      const { projectId } = idParam.parse(request.params);
      const { organizationId } = request.membership!;

      const project = await prisma.project.findFirst({
        where: { id: projectId, organizationId },
        select: { id: true },
      });
      if (!project) throw new NotFoundError('Project');

      const tasks = await prisma.task.findMany({
        where: { projectId, organizationId },
        select: { id: true, key: true, status: true, estimateHours: true },
      });

      const taskIds = tasks.map((t) => t.id);
      const dependencies = await prisma.taskDependency.findMany({
        where: { organizationId, successorId: { in: taskIds } },
        select: { predecessorId: true, successorId: true },
      });

      const edges: Edge[] = dependencies.map((d) => ({
        from: d.predecessorId,
        to: d.successorId,
      }));
      const adjacency = buildAdjacency(taskIds, edges);

      const byId = new Map(tasks.map((t) => [t.id, t]));
      const complete = (id: string) => {
        const task = byId.get(id);
        return task ? isTaskComplete(task.status) : false;
      };

      const { order, cyclic } = topologicalSort(adjacency);
      const path = criticalPath(adjacency, (id) => Number(byId.get(id)?.estimateHours ?? 0));
      const ready = readyNodes(adjacency, complete);

      const blocked = taskIds
        .filter((id) => !complete(id))
        .map((id) => ({ taskId: id, waitingOn: blockedBy(id, adjacency, complete) }))
        .filter((entry) => entry.waitingOn.length > 0);

      const schedule: ProjectSchedule = {
        order,
        cyclic,
        criticalPath: path.path,
        criticalPathHours: path.length,
        ready,
        blocked,
      };

      // Keys alongside ids so a client can render without a second lookup.
      return {
        ...schedule,
        tasks: Object.fromEntries(tasks.map((t) => [t.id, { key: t.key, status: t.status }])),
      };
    },
  );

  done();
}

function date(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}
