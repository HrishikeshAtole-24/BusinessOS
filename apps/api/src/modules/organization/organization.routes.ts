import {
  ConflictError,
  ERROR_CODES,
  NotFoundError,
  VersionConflictError,
  createOrganizationSchema,
  updateOrganizationSchema,
} from '@businessos/contracts';
import { provisionOrganization } from '@businessos/database';
import { findAvailableSlug, slugify } from '@businessos/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { diff, record } from '../../lib/audit.js';
import { definedOnly } from '../../lib/defined.js';
import { prisma } from '../../lib/prisma.js';
import { listActiveMemberships, resolveMembershipContext } from '../access/authorization.js';
import { setActiveOrganization } from '../identity/session.service.js';

const organizationIdParam = z.object({ organizationId: z.string().uuid() });

export function organizationRoutes(app: FastifyInstance, _opts: unknown, done: () => void): void {
  /**
   * POST /v1/organizations
   *
   * Any authenticated user may create an organization and becomes its owner.
   * Note there is no `requirePermission` here on purpose: permissions are
   * scoped to a tenant, and this call happens before any tenant exists.
   */
  app.post('/v1/organizations', { preHandler: app.requireAuth }, async (request, reply) => {
    const input = createOrganizationSchema.parse(request.body);
    const auth = request.auth!;

    const desired = input.slug ?? slugify(input.name);

    // An explicitly requested slug is honoured or rejected — silently handing
    // back "acme-2" when someone asked for "acme" is surprising. An inferred
    // slug may be adjusted, since the user never asked for it.
    if (input.slug) {
      const taken = await prisma.organization.findUnique({
        where: { slug: input.slug },
        select: { id: true },
      });
      if (taken) {
        throw new ConflictError('That URL name is already taken.', ERROR_CODES.DUPLICATE_RESOURCE, {
          slug: input.slug,
        });
      }
    }

    const organization = await prisma.$transaction(async (tx) => {
      const slug = input.slug
        ? input.slug
        : await findAvailableSlug(desired, async (candidate) => {
            const hit = await tx.organization.findUnique({
              where: { slug: candidate },
              select: { id: true },
            });
            return hit !== null;
          });

      const created = await provisionOrganization(tx, {
        name: input.name,
        slug,
        timezone: input.timezone,
        currency: input.currency,
        ownerUserId: auth.userId,
      });

      await record(tx, {
        organizationId: created.id,
        actorId: auth.userId,
        action: 'organization.created',
        entityType: 'organization',
        entityId: created.id,
        metadata: { name: created.name, slug: created.slug },
        ipAddress: request.ip,
        requestId: request.id,
      });

      return created;
    });

    // Creating an organization switches you into it — the alternative is
    // landing on an empty shell and having to pick the thing just created.
    await setActiveOrganization(prisma, auth.sessionId, organization.id);

    return reply.status(201).send({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      timezone: organization.timezone,
      currency: organization.currency,
    });
  });

  /** GET /v1/organizations — the tenants this user can act in. */
  app.get('/v1/organizations', { preHandler: app.requireAuth }, async (request) => {
    const data = await listActiveMemberships(prisma, request.auth!.userId);
    return { data };
  });

  /**
   * POST /v1/organizations/:organizationId/switch
   *
   * Changes the tenant this session acts in. Membership is verified before the
   * switch, so a forged organizationId cannot move the session anywhere its
   * user does not belong — and a 404 keeps the existence of other tenants
   * private (Section 32, IDOR).
   */
  app.post(
    '/v1/organizations/:organizationId/switch',
    { preHandler: app.requireAuth },
    async (request) => {
      const { organizationId } = organizationIdParam.parse(request.params);
      const auth = request.auth!;

      const context = await resolveMembershipContext(prisma, auth.userId, organizationId);
      if (!context) throw new NotFoundError('Organization');

      await setActiveOrganization(prisma, auth.sessionId, organizationId);

      const organization = await prisma.organization.findUniqueOrThrow({
        where: { id: organizationId },
        select: { id: true, name: true, slug: true, timezone: true, currency: true },
      });

      await record(prisma, {
        organizationId,
        actorId: auth.userId,
        action: 'organization.switched',
        entityType: 'organization',
        entityId: organizationId,
        ipAddress: request.ip,
        requestId: request.id,
      });

      return {
        organization,
        roles: context.roles,
        permissions: [...context.permissions],
      };
    },
  );

  /** GET /v1/organizations/current — the active tenant, with its version. */
  app.get(
    '/v1/organizations/current',
    { preHandler: app.requirePermission('organization.read') },
    async (request) => {
      return prisma.organization.findUniqueOrThrow({
        where: { id: request.membership!.organizationId },
        select: {
          id: true,
          name: true,
          slug: true,
          timezone: true,
          currency: true,
          status: true,
          version: true,
          createdAt: true,
        },
      });
    },
  );

  /**
   * PATCH /v1/organizations/current
   *
   * Optimistic concurrency (Section 11.2). The client echoes the version it
   * read; the update matches on it and bumps it. A stale version matches zero
   * rows, and the caller gets a 409 instead of silently discarding whatever
   * someone else saved in between.
   */
  app.patch(
    '/v1/organizations/current',
    { preHandler: app.requirePermission('organization.update') },
    async (request) => {
      const input = updateOrganizationSchema.parse(request.body);
      const { organizationId } = request.membership!;
      const auth = request.auth!;

      const before = await prisma.organization.findUniqueOrThrow({
        where: { id: organizationId },
        select: { name: true, timezone: true, currency: true, version: true },
      });

      // Zod leaves optional fields as explicit `undefined`. Strip them so the
      // update names only the columns the caller actually sent.
      const { version, ...rest } = input;
      const changes = definedOnly(rest);

      const updated = await prisma.$transaction(async (tx) => {
        const result = await tx.organization.updateMany({
          where: { id: organizationId, version },
          data: { ...changes, version: { increment: 1 } },
        });

        // updateMany reports the row count, which is what makes the guard
        // work: `update` would throw a not-found and hide the real cause.
        if (result.count === 0) throw new VersionConflictError(version);

        const fresh = await tx.organization.findUniqueOrThrow({
          where: { id: organizationId },
          select: {
            id: true,
            name: true,
            slug: true,
            timezone: true,
            currency: true,
            version: true,
          },
        });

        await record(tx, {
          organizationId,
          actorId: auth.userId,
          action: 'organization.updated',
          entityType: 'organization',
          entityId: organizationId,
          metadata: { changes: diff(before, changes) },
          ipAddress: request.ip,
          requestId: request.id,
        });

        return fresh;
      });

      return updated;
    },
  );

  /** GET /v1/organizations/current/members */
  app.get(
    '/v1/organizations/current/members',
    { preHandler: app.requirePermission('member.read') },
    async (request) => {
      const members = await prisma.membership.findMany({
        where: { organizationId: request.membership!.organizationId },
        select: {
          id: true,
          status: true,
          joinedAt: true,
          user: { select: { id: true, name: true, email: true, lastLoginAt: true } },
          roles: { select: { role: { select: { key: true, name: true } } } },
        },
        orderBy: { joinedAt: 'asc' },
      });

      return {
        data: members.map((m) => ({
          id: m.id,
          status: m.status,
          joinedAt: m.joinedAt,
          user: m.user,
          roles: m.roles.map((r) => r.role),
        })),
      };
    },
  );

  /** GET /v1/organizations/current/roles */
  app.get(
    '/v1/organizations/current/roles',
    { preHandler: app.requirePermission('role.read') },
    async (request) => {
      const roles = await prisma.role.findMany({
        where: { organizationId: request.membership!.organizationId },
        select: {
          id: true,
          key: true,
          name: true,
          description: true,
          isSystem: true,
          _count: { select: { permissions: true, memberships: true } },
        },
        orderBy: { key: 'asc' },
      });

      return {
        data: roles.map((r) => ({
          id: r.id,
          key: r.key,
          name: r.name,
          description: r.description,
          isSystem: r.isSystem,
          permissionCount: r._count.permissions,
          memberCount: r._count.memberships,
        })),
      };
    },
  );

  done();
}
