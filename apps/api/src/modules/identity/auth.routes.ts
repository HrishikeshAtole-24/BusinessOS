import {
  ConflictError,
  ERROR_CODES,
  UnauthenticatedError,
  loginSchema,
  signupSchema,
  type SessionContext,
} from '@businessos/contracts';
import { provisionOrganization } from '@businessos/database';
import { findAvailableSlug, hashPassword, verifyPassword } from '@businessos/domain';
import type { FastifyInstance } from 'fastify';
import { record } from '../../lib/audit.js';
import { prisma } from '../../lib/prisma.js';
import { listActiveMemberships, resolveMembershipContext } from '../access/authorization.js';
import {
  SESSION_COOKIE,
  createSession,
  revokeSession,
  sessionCookieOptions,
} from './session.service.js';

/**
 * Authentication routes — report Sections 18.2 and 25.
 */

/**
 * Auth endpoints get their own rate limit, far tighter than the global 300/min.
 *
 * Section 18.4: "rate-limit authentication, password reset, invitation and
 * expensive endpoints." Keyed by IP + email so one attacker cannot lock out a
 * victim by hammering their address from elsewhere — which is what a pure
 * per-account limit turns into.
 */
const AUTH_RATE_LIMIT = {
  config: {
    rateLimit: {
      max: 10,
      timeWindow: '5 minutes',
      keyGenerator: (request: { ip: string; body?: unknown }) => {
        // Only a genuine string counts. Anything else — an object, an array —
        // would stringify to "[object Object]" and put every such request in
        // one shared bucket, which is both a way to exhaust someone else's
        // budget and a way to dodge the per-account limit.
        const body: unknown = request.body;
        const raw =
          typeof body === 'object' && body !== null && 'email' in body
            ? (body as { email?: unknown }).email
            : undefined;
        const email = typeof raw === 'string' ? raw.toLowerCase().slice(0, 320) : '';
        return `auth:${request.ip}:${email}`;
      },
    },
  },
};

export function authRoutes(app: FastifyInstance, _opts: unknown, done: () => void): void {
  /**
   * POST /v1/auth/signup
   *
   * Creates the user and, when a company name is supplied, their first
   * organization with the six system roles and an owner membership — all in one
   * transaction. A half-created tenant with no owner cannot be administered.
   */
  app.post('/v1/auth/signup', AUTH_RATE_LIMIT, async (request, reply) => {
    const input = signupSchema.parse(request.body);

    const existing = await prisma.user.findUnique({
      where: { email: input.email },
      select: { id: true },
    });
    if (existing) {
      // Signup necessarily reveals whether an address is registered — there is
      // no way to create an account at a taken address. The mitigation is the
      // rate limit above, which makes enumerating a list impractical.
      throw new ConflictError(
        'An account with this email already exists. Sign in instead.',
        ERROR_CODES.DUPLICATE_RESOURCE,
      );
    }

    const passwordHash = await hashPassword(input.password);

    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: input.email,
          name: input.name,
          passwordHash,
          // Email verification is not wired yet; until it is, marking accounts
          // ACTIVE keeps the flow usable. This becomes PENDING_VERIFICATION the
          // moment the verification email exists.
          status: 'ACTIVE',
        },
        select: { id: true, email: true, name: true },
      });

      if (!input.organizationName) return { user, organization: null };

      const slug = await findAvailableSlug(input.organizationName, async (candidate) => {
        const hit = await tx.organization.findUnique({
          where: { slug: candidate },
          select: { id: true },
        });
        return hit !== null;
      });

      const organization = await provisionOrganization(tx, {
        name: input.organizationName,
        slug,
        ownerUserId: user.id,
      });

      await record(tx, {
        organizationId: organization.id,
        actorId: user.id,
        action: 'organization.created',
        entityType: 'organization',
        entityId: organization.id,
        metadata: { name: organization.name, slug: organization.slug, viaSignup: true },
        ipAddress: request.ip,
        requestId: request.id,
      });

      return { user, organization };
    });

    const session = await createSession(prisma, {
      userId: result.user.id,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      activeOrganizationId: result.organization?.id ?? null,
    });

    reply.setCookie(SESSION_COOKIE, session.token, sessionCookieOptions(session.expiresAt));

    return reply.status(201).send({
      user: result.user,
      organization: result.organization
        ? {
            id: result.organization.id,
            name: result.organization.name,
            slug: result.organization.slug,
            timezone: result.organization.timezone,
            currency: result.organization.currency,
          }
        : null,
    });
  });

  /**
   * POST /v1/auth/login
   */
  app.post('/v1/auth/login', AUTH_RATE_LIMIT, async (request, reply) => {
    const input = loginSchema.parse(request.body);

    const user = await prisma.user.findUnique({
      where: { email: input.email },
      select: { id: true, email: true, name: true, passwordHash: true, status: true },
    });

    /**
     * One message and one code for every failure: unknown address, wrong
     * password, invite-only account with no password set, suspended account.
     * Anything more specific is a login oracle.
     *
     * The dummy verify on the unknown-user path matters as much as the message.
     * Returning immediately would make "no such user" measurably faster than
     * "wrong password", and that timing difference alone enumerates accounts.
     */
    const invalid = new UnauthenticatedError(
      'Incorrect email or password.',
      ERROR_CODES.INVALID_CREDENTIALS,
    );

    if (!user?.passwordHash) {
      await verifyPassword(
        '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$3+FqjPq6nMBpNSFTHkPCXvpVMPMMqLIPGkFtLKJRWJk',
        input.password,
      );
      throw invalid;
    }

    const ok = await verifyPassword(user.passwordHash, input.password);
    if (!ok || user.status !== 'ACTIVE') throw invalid;

    const memberships = await listActiveMemberships(prisma, user.id);
    // Drop straight into the only tenant when there is exactly one. With
    // several, the client picks and calls the switch endpoint.
    const activeOrganizationId = memberships.length === 1 ? memberships[0]!.id : null;

    const session = await createSession(prisma, {
      userId: user.id,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      activeOrganizationId,
    });

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    if (activeOrganizationId) {
      await record(prisma, {
        organizationId: activeOrganizationId,
        actorId: user.id,
        action: 'user.logged_in',
        entityType: 'user',
        entityId: user.id,
        ipAddress: request.ip,
        requestId: request.id,
      });
    }

    reply.setCookie(SESSION_COOKIE, session.token, sessionCookieOptions(session.expiresAt));

    return reply.send({
      user: { id: user.id, email: user.email, name: user.name },
      memberships,
      activeOrganizationId,
    });
  });

  /**
   * POST /v1/auth/logout
   *
   * Revokes server-side first, then clears the cookie. Clearing only the cookie
   * would leave a token that still authenticates if it was ever captured.
   */
  app.post('/v1/auth/logout', { preHandler: app.requireAuth }, async (request, reply) => {
    const auth = request.auth!;
    await revokeSession(prisma, auth.sessionId);

    if (auth.activeOrganizationId) {
      await record(prisma, {
        organizationId: auth.activeOrganizationId,
        actorId: auth.userId,
        action: 'user.logged_out',
        entityType: 'session',
        entityId: auth.sessionId,
        ipAddress: request.ip,
        requestId: request.id,
      });
    }

    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.status(204).send();
  });

  /**
   * GET /v1/auth/me
   *
   * Everything the web shell needs in one call: identity, active tenant,
   * effective permissions, roles, and the organizations available to switch to.
   */
  app.get(
    '/v1/auth/me',
    { preHandler: app.requireAuth },
    async (request): Promise<SessionContext> => {
      const auth = request.auth!;
      const memberships = await listActiveMemberships(prisma, auth.userId);

      const active = auth.activeOrganizationId
        ? (memberships.find((m) => m.id === auth.activeOrganizationId) ?? null)
        : null;

      if (!active) {
        return {
          user: { id: auth.userId, email: auth.email, name: auth.name },
          organization: null,
          permissions: [],
          roles: [],
          memberships,
        };
      }

      const context = await resolveMembershipContext(prisma, auth.userId, active.id);

      return {
        user: { id: auth.userId, email: auth.email, name: auth.name },
        organization: active,
        permissions: context ? [...context.permissions] : [],
        roles: context?.roles ?? [],
        memberships,
      };
    },
  );

  done();
}
