import type { PermissionKey } from '@businessos/contracts';
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '@businessos/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { prisma } from '../lib/prisma.js';
import {
  resolveMembershipContext,
  type MembershipContext,
} from '../modules/access/authorization.js';
import { SESSION_COOKIE, resolveSession } from '../modules/identity/session.service.js';

/**
 * Authentication, tenant context and permission guards.
 *
 * Report Section 18.3 states the order plainly: "authenticate first; authorize
 * second", and "perform tenant membership checks before resource
 * authorization". This plugin exposes three preHandlers matching those layers:
 *
 *   requireAuth        who are you?
 *   requireOrg         which tenant are you acting in, and do you belong to it?
 *   requirePermission  may you do this here?
 *
 * They compose in that order. `requirePermission` implies `requireOrg`, which
 * implies `requireAuth`, so a route only declares its outermost need.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** Present after requireAuth. */
    auth?: {
      sessionId: string;
      userId: string;
      email: string;
      name: string;
      activeOrganizationId: string | null;
    };
    /** Present after requireOrg. */
    membership?: MembershipContext;
  }

  interface FastifyInstance {
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireOrg: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requirePermission: (
      ...permissions: PermissionKey[]
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export const authPlugin = fp(
  function auth(app: FastifyInstance, _opts: unknown, done: () => void) {
    /** Layer 1 — identity. */
    app.decorate('requireAuth', async function requireAuth(request: FastifyRequest) {
      if (request.auth) return;

      const token = request.cookies[SESSION_COOKIE];
      if (!token) throw new UnauthenticatedError('Sign in to continue.');

      const session = await resolveSession(prisma, token);
      if (!session) {
        // Covers expired, revoked, forged and deactivated-user tokens with one
        // message. Distinguishing them tells an attacker which of their guesses
        // corresponded to a real session.
        throw new UnauthenticatedError('Your session has expired. Sign in again.');
      }

      request.auth = {
        sessionId: session.sessionId,
        userId: session.userId,
        email: session.email,
        name: session.name,
        activeOrganizationId: session.activeOrganizationId,
      };

      // Feed the request logger so every subsequent line carries the actor.
      request.userId = session.userId;
    });

    /** Layer 2 — tenant. */
    app.decorate(
      'requireOrg',
      async function requireOrg(request: FastifyRequest, reply: FastifyReply) {
        await app.requireAuth(request, reply);
        if (request.membership) return;

        const auth = request.auth;
        if (!auth) throw new UnauthenticatedError();

        /**
         * The organization comes from the SESSION, never from the request body,
         * a query parameter or a header. Section 9.3 is unambiguous about this,
         * and it is the single control that makes tenant isolation hold: a
         * client-supplied organizationId is a client-chosen blast radius.
         */
        const organizationId = auth.activeOrganizationId;
        if (!organizationId) {
          throw new ForbiddenError('Select an organization before continuing.', {
            reason: 'NO_ACTIVE_ORGANIZATION',
          });
        }

        const context = await resolveMembershipContext(prisma, auth.userId, organizationId);
        if (!context) {
          // Membership was revoked, suspended, or the org was archived while the
          // session stayed alive. 404 rather than 403 — see TENANT_MISMATCH.
          throw new NotFoundError('Organization');
        }

        request.membership = context;
        request.organizationId = context.organizationId;
      },
    );

    /** Layer 3 — permission. */
    app.decorate('requirePermission', function requirePermission(...permissions: PermissionKey[]) {
      return async function guard(request: FastifyRequest, reply: FastifyReply) {
        await app.requireOrg(request, reply);

        const context = request.membership;
        if (!context) throw new UnauthenticatedError();

        // ALL of the listed permissions, not any. A route asking for two
        // permissions is describing two things it will do.
        const missing = permissions.filter((p) => !context.permissions.has(p));
        if (missing.length > 0) {
          request.log.warn(
            {
              required: permissions,
              missing,
              roles: context.roles,
              securityEvent: 'permission_denied',
            },
            'permission denied',
          );
          throw new ForbiddenError('You do not have permission to perform this action.', {
            required: permissions,
          });
        }
      };
    });

    done();
  },
  { name: 'auth', dependencies: ['request-context'] },
);
