import { NotFoundError } from '@businessos/contracts';
import { orderForDelivery } from '@businessos/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';

/**
 * The notification bell.
 *
 * Ordering goes through the heap in `@businessos/domain` rather than an ORDER
 * BY, because the rule is not a column: it is priority band first, then age
 * within the band. Expressing that in SQL means a CASE in the ORDER BY that
 * has to be kept in sync with the enum; the comparator is the single source of
 * truth and is unit tested.
 */

const listQuerySchema = z.object({
  unreadOnly: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export function notificationRoutes(app: FastifyInstance, _opts: unknown, done: () => void): void {
  /** GET /v1/notifications */
  app.get('/v1/notifications', { preHandler: app.requireAuth }, async (request) => {
    const query = listQuerySchema.parse(request.query);
    const userId = request.auth!.userId;

    // Scoped to the recipient, not to the organization: notifications belong to
    // the person, and someone in two tenants sees both here.
    const rows = await prisma.notification.findMany({
      where: { recipientId: userId, ...(query.unreadOnly ? { readAt: null } : {}) },
      select: {
        id: true,
        type: true,
        priority: true,
        title: true,
        body: true,
        link: true,
        entityType: true,
        entityId: true,
        readAt: true,
        createdAt: true,
        organization: { select: { id: true, name: true } },
      },
      // Take a recent window from the database, then order it properly in
      // memory. Ordering by createdAt alone here would let a low-priority item
      // push an urgent one out of the window.
      orderBy: { createdAt: 'desc' },
      take: Math.max(query.limit * 3, 90),
    });

    const ordered = orderForDelivery(
      rows.map((n) => ({ ...n, createdAt: n.createdAt.getTime() })),
      query.limit,
    );

    const unread = await prisma.notification.count({
      where: { recipientId: userId, readAt: null },
    });

    return {
      data: ordered.map((n) => ({
        ...n,
        createdAt: new Date(n.createdAt).toISOString(),
        readAt: n.readAt?.toISOString() ?? null,
      })),
      unread,
    };
  });

  /** GET /v1/notifications/unread-count — for the bell badge. */
  app.get('/v1/notifications/unread-count', { preHandler: app.requireAuth }, async (request) => {
    const unread = await prisma.notification.count({
      where: { recipientId: request.auth!.userId, readAt: null },
    });
    return { unread };
  });

  /** POST /v1/notifications/:notificationId/read */
  app.post(
    '/v1/notifications/:notificationId/read',
    { preHandler: app.requireAuth },
    async (request) => {
      const { notificationId } = z
        .object({ notificationId: z.string().uuid() })
        .parse(request.params);

      // recipientId in the filter, not just the id: without it anyone could
      // mark someone else's notification read.
      const result = await prisma.notification.updateMany({
        where: { id: notificationId, recipientId: request.auth!.userId, readAt: null },
        data: { readAt: new Date() },
      });
      if (result.count === 0) throw new NotFoundError('Notification');

      return { notificationId, read: true };
    },
  );

  /** POST /v1/notifications/read-all */
  app.post('/v1/notifications/read-all', { preHandler: app.requireAuth }, async (request) => {
    const result = await prisma.notification.updateMany({
      where: { recipientId: request.auth!.userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { marked: result.count };
  });

  done();
}
