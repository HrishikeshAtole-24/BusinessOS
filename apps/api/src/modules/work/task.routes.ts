import {
  BusinessRuleError,
  ERROR_CODES,
  InvalidStateTransitionError,
  NotFoundError,
  VersionConflictError,
  addDependencySchema,
  buildPage,
  createCommentSchema,
  createTaskSchema,
  taskQuerySchema,
  toPrismaPageArgs,
  updateTaskSchema,
} from '@businessos/contracts';
import {
  buildAdjacency,
  findCycle,
  isTaskComplete,
  taskStateMachine,
  wouldCreateEdgeCycle,
  type Edge,
} from '@businessos/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { diff, record } from '../../lib/audit.js';
import { definedOnly } from '../../lib/defined.js';
import { prisma } from '../../lib/prisma.js';

/**
 * Tasks and the dependency graph.
 *
 * Two invariants here that the database cannot hold on its own:
 *
 *   1. The dependency graph must stay acyclic (Section 8.4). The composite
 *      primary key stops a duplicate edge; it cannot see a three-hop loop.
 *   2. Status must follow the Section 8.1 transition table.
 */

const taskParam = z.object({ taskId: z.string().uuid() });
const projectParam = z.object({ projectId: z.string().uuid() });

const taskSelect = {
  id: true,
  key: true,
  title: true,
  status: true,
  priority: true,
  dueDate: true,
  estimateHours: true,
  assignee: { select: { id: true, firstName: true, lastName: true } },
  _count: { select: { blockedBy: true, blocks: true } },
} as const;

/**
 * Load the whole project's dependency edges.
 *
 * Scoped to one project because that is the natural blast radius of a cycle —
 * dependencies never cross projects — and it keeps the graph small enough that
 * an in-memory traversal beats a recursive CTE.
 */
async function loadProjectGraph(organizationId: string, projectId: string) {
  const tasks = await prisma.task.findMany({
    where: { organizationId, projectId },
    select: { id: true, key: true, status: true },
  });
  const ids = tasks.map((t) => t.id);
  const dependencies = await prisma.taskDependency.findMany({
    where: { organizationId, successorId: { in: ids } },
    select: { predecessorId: true, successorId: true },
  });
  const edges: Edge[] = dependencies.map((d) => ({ from: d.predecessorId, to: d.successorId }));
  return { tasks, ids, edges, adjacency: buildAdjacency(ids, edges) };
}

export function taskRoutes(app: FastifyInstance, _opts: unknown, done: () => void): void {
  /** GET /v1/tasks */
  app.get('/v1/tasks', { preHandler: app.requirePermission('task.read') }, async (request) => {
    const query = taskQuerySchema.parse(request.query);
    const { organizationId } = request.membership!;

    const rows = await prisma.task.findMany({
      where: {
        organizationId,
        ...definedOnly({
          projectId: query.projectId,
          status: query.status,
          priority: query.priority,
          assigneeId: query.assigneeId,
        }),
        ...(query.q
          ? {
              OR: [
                { title: { contains: query.q, mode: 'insensitive' as const } },
                { key: { contains: query.q, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      select: { ...taskSelect, project: { select: { id: true, key: true, name: true } } },
      orderBy: { id: 'asc' },
      ...toPrismaPageArgs(query),
    });

    const page = buildPage(rows, query.limit);
    return {
      data: page.data.map(serialize),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  });

  /**
   * POST /v1/projects/:projectId/tasks
   *
   * The task key is allocated by incrementing the project's counter inside the
   * same transaction as the insert, so two concurrent creates cannot both take
   * VEP-7. Counting existing tasks instead would race.
   */
  app.post(
    '/v1/projects/:projectId/tasks',
    { preHandler: app.requirePermission('task.create') },
    async (request, reply) => {
      const { projectId } = projectParam.parse(request.params);
      const input = createTaskSchema.parse(request.body);
      const { organizationId } = request.membership!;

      const project = await prisma.project.findFirst({
        where: { id: projectId, organizationId },
        select: { id: true, key: true },
      });
      if (!project) throw new NotFoundError('Project');

      if (input.dependsOn?.length) {
        const found = await prisma.task.count({
          where: { id: { in: input.dependsOn }, organizationId, projectId },
        });
        if (found !== input.dependsOn.length) {
          throw new BusinessRuleError('Some dependencies are not tasks in this project.');
        }
      }

      const task = await prisma.$transaction(async (tx) => {
        const counter = await tx.project.update({
          where: { id: projectId },
          data: { taskSequence: { increment: 1 } },
          select: { taskSequence: true },
        });

        const created = await tx.task.create({
          data: {
            organizationId,
            projectId,
            key: `${project.key}-${counter.taskSequence}`,
            title: input.title,
            priority: input.priority,
            reporterId: null,
            ...definedOnly({
              description: input.description,
              assigneeId: input.assigneeId ?? undefined,
              dueDate: input.dueDate ? new Date(input.dueDate) : undefined,
              estimateHours: input.estimateHours,
              parentId: input.parentId ?? undefined,
            }),
          },
          select: taskSelect,
        });

        // A brand-new task has no successors, so no edge into it can close a
        // loop — safe to insert without re-running cycle detection.
        if (input.dependsOn?.length) {
          await tx.taskDependency.createMany({
            data: input.dependsOn.map((predecessorId) => ({
              organizationId,
              predecessorId,
              successorId: created.id,
            })),
            skipDuplicates: true,
          });
        }

        await record(tx, {
          organizationId,
          actorId: request.auth!.userId,
          action: 'task.created',
          entityType: 'task',
          entityId: created.id,
          metadata: { key: created.key, title: created.title },
          ipAddress: request.ip,
          requestId: request.id,
        });

        return created;
      });

      return reply.status(201).send(serialize(task));
    },
  );

  /** GET /v1/tasks/:taskId */
  app.get(
    '/v1/tasks/:taskId',
    { preHandler: app.requirePermission('task.read') },
    async (request) => {
      const { taskId } = taskParam.parse(request.params);
      const { organizationId } = request.membership!;

      const task = await prisma.task.findFirst({
        where: { id: taskId, organizationId },
        select: {
          ...taskSelect,
          description: true,
          actualHours: true,
          version: true,
          completedAt: true,
          createdAt: true,
          project: { select: { id: true, key: true, name: true } },
          blockedBy: {
            select: {
              predecessor: { select: { id: true, key: true, title: true, status: true } },
            },
          },
          blocks: {
            select: {
              successor: { select: { id: true, key: true, title: true, status: true } },
            },
          },
          subtasks: { select: { id: true, key: true, title: true, status: true } },
          comments: {
            select: {
              id: true,
              body: true,
              createdAt: true,
              author: { select: { id: true, name: true } },
            },
            orderBy: { createdAt: 'asc' },
          },
        },
      });
      if (!task) throw new NotFoundError('Task');

      const blockers = task.blockedBy.map((d) => d.predecessor);

      return {
        ...serialize(task),
        description: task.description,
        actualHours: task.actualHours ? Number(task.actualHours) : null,
        version: task.version,
        project: task.project,
        blockedBy: blockers,
        blocks: task.blocks.map((d) => d.successor),
        subtasks: task.subtasks,
        comments: task.comments,
        /** Which blockers are still open — the reason this cannot start. */
        waitingOn: blockers.filter((b) => !isTaskComplete(b.status)),
        allowedTransitions: taskStateMachine.allowedFrom(task.status),
      };
    },
  );

  /** PATCH /v1/tasks/:taskId */
  app.patch(
    '/v1/tasks/:taskId',
    { preHandler: app.requirePermission('task.update') },
    async (request) => {
      const { taskId } = taskParam.parse(request.params);
      const input = updateTaskSchema.parse(request.body);
      const { organizationId } = request.membership!;

      const before = await prisma.task.findFirst({
        where: { id: taskId, organizationId },
        select: {
          title: true,
          status: true,
          priority: true,
          assigneeId: true,
          version: true,
          blockedBy: { select: { predecessor: { select: { key: true, status: true } } } },
        },
      });
      if (!before) throw new NotFoundError('Task');

      if (input.status && input.status !== before.status) {
        const check = taskStateMachine.check(before.status, input.status);
        if (!check.ok) {
          throw new InvalidStateTransitionError(before.status, input.status, check.allowed);
        }

        /**
         * The report's example rule (Section 10): "You should not be able to
         * mark Frontend ready if the required backend dependency is not
         * complete."
         *
         * Enforced only on the move INTO a working state. Moving to BLOCKED or
         * back to TODO must stay possible precisely when things are blocked.
         */
        if (input.status === 'IN_REVIEW' || input.status === 'DONE') {
          const open = before.blockedBy
            .map((d) => d.predecessor)
            .filter((p) => !isTaskComplete(p.status));
          if (open.length > 0) {
            throw new BusinessRuleError(
              `Blocked by ${open.map((p) => p.key).join(', ')}.`,
              ERROR_CODES.BUSINESS_RULE_VIOLATION,
              { waitingOn: open.map((p) => p.key) },
            );
          }
        }
      }

      const { version, dueDate, ...rest } = input;
      const changes = definedOnly({
        ...rest,
        ...(dueDate !== undefined ? { dueDate: dueDate === null ? null : new Date(dueDate) } : {}),
        // completedAt is derived from status, never sent by the client — two
        // fields that can disagree are two fields that will.
        ...(input.status === 'DONE' && before.status !== 'DONE' ? { completedAt: new Date() } : {}),
        ...(input.status && input.status !== 'DONE' && before.status === 'DONE'
          ? { completedAt: null }
          : {}),
      });

      return prisma.$transaction(async (tx) => {
        const result = await tx.task.updateMany({
          where: { id: taskId, organizationId, version },
          data: { ...changes, version: { increment: 1 } },
        });
        if (result.count === 0) throw new VersionConflictError(version);

        const fresh = await tx.task.findUniqueOrThrow({
          where: { id: taskId },
          select: { ...taskSelect, version: true },
        });

        await record(tx, {
          organizationId,
          actorId: request.auth!.userId,
          action:
            input.status && input.status !== before.status ? 'task.status_changed' : 'task.updated',
          entityType: 'task',
          entityId: taskId,
          metadata: { key: fresh.key, changes: diff(before, changes) },
          ipAddress: request.ip,
          requestId: request.id,
        });

        return { ...serialize(fresh), version: fresh.version };
      });
    },
  );

  /**
   * POST /v1/tasks/:taskId/dependencies
   *
   * The flagship check. Adding `predecessor -> task` is refused when the
   * predecessor is already reachable FROM this task, because that closes a
   * loop — and a loop makes the project unschedulable: every task in it waits
   * on another task in it, forever.
   */
  app.post(
    '/v1/tasks/:taskId/dependencies',
    { preHandler: app.requirePermission('task.update') },
    async (request, reply) => {
      const { taskId } = taskParam.parse(request.params);
      const { predecessorId } = addDependencySchema.parse(request.body);
      const { organizationId } = request.membership!;

      const task = await prisma.task.findFirst({
        where: { id: taskId, organizationId },
        select: { id: true, key: true, projectId: true },
      });
      if (!task) throw new NotFoundError('Task');

      const predecessor = await prisma.task.findFirst({
        where: { id: predecessorId, organizationId, projectId: task.projectId },
        select: { id: true, key: true },
      });
      if (!predecessor) {
        throw new NotFoundError('Predecessor task in this project');
      }

      const { adjacency } = await loadProjectGraph(organizationId, task.projectId);

      if (wouldCreateEdgeCycle(predecessorId, taskId, adjacency)) {
        // findCycle on the hypothetical graph gives the actual loop, so the
        // error can name the tasks involved rather than just saying "cycle".
        const { ids, edges } = await loadProjectGraph(organizationId, task.projectId);
        const hypothetical = buildAdjacency(ids, [...edges, { from: predecessorId, to: taskId }]);
        const cycle = findCycle(hypothetical) ?? [];
        const keys = await prisma.task.findMany({
          where: { id: { in: cycle }, organizationId },
          select: { id: true, key: true },
        });
        const keyById = new Map(keys.map((k) => [k.id, k.key]));

        throw new BusinessRuleError(
          `That dependency is circular: ${cycle.map((id) => keyById.get(id) ?? '?').join(' -> ')}`,
          ERROR_CODES.TASK_DEPENDENCY_CYCLE,
          { cycle: cycle.map((id) => keyById.get(id) ?? id) },
        );
      }

      await prisma.$transaction(async (tx) => {
        await tx.taskDependency.create({
          data: { organizationId, predecessorId, successorId: taskId },
        });
        await record(tx, {
          organizationId,
          actorId: request.auth!.userId,
          action: 'task.dependency_added',
          entityType: 'task',
          entityId: taskId,
          metadata: { blockedBy: predecessor.key, task: task.key },
          ipAddress: request.ip,
          requestId: request.id,
        });
      });

      return reply.status(201).send({ taskId, predecessorId });
    },
  );

  /** DELETE /v1/tasks/:taskId/dependencies/:predecessorId */
  app.delete(
    '/v1/tasks/:taskId/dependencies/:predecessorId',
    { preHandler: app.requirePermission('task.update') },
    async (request, reply) => {
      const { taskId, predecessorId } = z
        .object({ taskId: z.string().uuid(), predecessorId: z.string().uuid() })
        .parse(request.params);
      const { organizationId } = request.membership!;

      const result = await prisma.taskDependency.deleteMany({
        where: { organizationId, predecessorId, successorId: taskId },
      });
      if (result.count === 0) throw new NotFoundError('Dependency');

      return reply.status(204).send();
    },
  );

  /** POST /v1/tasks/:taskId/comments */
  app.post(
    '/v1/tasks/:taskId/comments',
    { preHandler: app.requirePermission('task.read') },
    async (request, reply) => {
      const { taskId } = taskParam.parse(request.params);
      const { body } = createCommentSchema.parse(request.body);
      const { organizationId } = request.membership!;

      const task = await prisma.task.findFirst({
        where: { id: taskId, organizationId },
        select: { id: true },
      });
      if (!task) throw new NotFoundError('Task');

      const comment = await prisma.taskComment.create({
        data: { organizationId, taskId, authorId: request.auth!.userId, body },
        select: {
          id: true,
          body: true,
          createdAt: true,
          author: { select: { id: true, name: true } },
        },
      });

      return reply.status(201).send(comment);
    },
  );

  done();
}

/** Decimals become numbers and dates become YYYY-MM-DD at the boundary. */
function serialize<
  T extends {
    dueDate: Date | null;
    estimateHours: unknown;
    _count?: { blockedBy: number; blocks: number };
  },
>(task: T) {
  const { _count, ...rest } = task;
  return {
    ...rest,
    dueDate: task.dueDate ? task.dueDate.toISOString().slice(0, 10) : null,
    estimateHours: task.estimateHours ? Number(task.estimateHours) : null,
    blockedByCount: _count?.blockedBy ?? 0,
    blocksCount: _count?.blocks ?? 0,
  };
}
