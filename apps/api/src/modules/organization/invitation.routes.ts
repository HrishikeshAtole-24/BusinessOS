import {
  AppError,
  BusinessRuleError,
  ConflictError,
  ERROR_CODES,
  NotFoundError,
  ValidationError,
  acceptInvitationSchema,
  createInvitationSchema,
} from '@businessos/contracts';
import { assignRole } from '@businessos/database';
import {
  TOKEN_LIFETIMES,
  expiresIn,
  generateToken,
  hashPassword,
  hashToken,
} from '@businessos/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { record } from '../../lib/audit.js';
import { prisma } from '../../lib/prisma.js';
import {
  SESSION_COOKIE,
  createSession,
  sessionCookieOptions,
} from '../identity/session.service.js';

/**
 * Invitations — report Section 39 item 9.
 *
 * The invite token is the only thing standing between a stranger and a tenant,
 * so it is treated exactly like a session token: 256 random bits, stored as a
 * SHA-256 hash, single use, and time limited.
 */

const invitationIdParam = z.object({ invitationId: z.string().uuid() });

export function invitationRoutes(app: FastifyInstance, _opts: unknown, done: () => void): void {
  /**
   * POST /v1/invitations
   *
   * Rate limited well below the global budget: an invitation endpoint that
   * sends email is a spam relay if left open (Section 18.4).
   */
  app.post(
    '/v1/invitations',
    {
      preHandler: app.requirePermission('member.invite'),
      config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
    },
    async (request, reply) => {
      const input = createInvitationSchema.parse(request.body);
      const { organizationId } = request.membership!;
      const auth = request.auth!;

      const role = await prisma.role.findUnique({
        where: { organizationId_key: { organizationId, key: input.roleKey } },
        select: { id: true, key: true, name: true },
      });
      if (!role) throw new ValidationError('That role does not exist.', { roleKey: input.roleKey });

      /**
       * Only an owner may create another owner. Without this, anyone holding
       * `member.invite` — HR, for instance — could mint themselves a
       * co-owner and escalate straight past every other control.
       */
      if (role.key === 'owner' && !request.membership!.roles.includes('owner')) {
        throw new BusinessRuleError('Only an owner can invite another owner.');
      }

      const alreadyMember = await prisma.membership.findFirst({
        where: { organizationId, user: { email: input.email }, status: 'ACTIVE' },
        select: { id: true },
      });
      if (alreadyMember) {
        throw new ConflictError(
          'That person is already a member of this organization.',
          ERROR_CODES.DUPLICATE_RESOURCE,
        );
      }

      const { plaintext, hash } = generateToken();

      const invitation = await prisma.$transaction(async (tx) => {
        // Supersede any live invite for this address. The unique constraint is
        // (organizationId, email, status), so leaving an old PENDING row in
        // place would block the new one — and re-inviting someone whose first
        // email got lost is a normal thing to do.
        await tx.invitation.updateMany({
          where: { organizationId, email: input.email, status: 'PENDING' },
          data: { status: 'REVOKED', revokedAt: new Date() },
        });

        const created = await tx.invitation.create({
          data: {
            organizationId,
            email: input.email,
            roleId: role.id,
            tokenHash: hash,
            invitedById: auth.userId,
            expiresAt: expiresIn(TOKEN_LIFETIMES.INVITATION_MS),
          },
          select: { id: true, email: true, expiresAt: true, createdAt: true },
        });

        await record(tx, {
          organizationId,
          actorId: auth.userId,
          action: 'invitation.sent',
          entityType: 'invitation',
          entityId: created.id,
          metadata: { email: input.email, roleKey: role.key },
          ipAddress: request.ip,
          requestId: request.id,
        });

        return created;
      });

      /**
       * The plaintext token is returned in the response only because email
       * delivery does not exist yet — the email queue is wired but has no
       * sender. This MUST become a queued email before any deployment: an
       * invite link in an API response is visible to anyone who can read that
       * response, which is not the same set of people as the invitee.
       */
      return reply.status(201).send({
        invitation: { ...invitation, role: { key: role.key, name: role.name } },
        acceptToken: plaintext,
        acceptUrl: `/invite/${plaintext}`,
      });
    },
  );

  /**
   * GET /v1/invitations — pending invites for the active organization.
   *
   * Guarded by `member.invite`, NOT `member.read`. Employees hold `member.read`
   * so they can see the staff directory, but a pending-invitations list is a
   * different thing: it exposes who is being recruited, for which role, and by
   * whom — hiring signal that has not been announced yet. Reading the invite
   * list is part of administering invites, so it takes the same permission as
   * creating one.
   */
  app.get(
    '/v1/invitations',
    { preHandler: app.requirePermission('member.invite') },
    async (request) => {
      const invitations = await prisma.invitation.findMany({
        where: { organizationId: request.membership!.organizationId, status: 'PENDING' },
        select: {
          id: true,
          email: true,
          expiresAt: true,
          createdAt: true,
          role: { select: { key: true, name: true } },
          invitedBy: { select: { name: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
      });

      const now = new Date();
      return {
        data: invitations.map((i) => ({ ...i, expired: i.expiresAt < now })),
      };
    },
  );

  /** DELETE /v1/invitations/:invitationId */
  app.delete(
    '/v1/invitations/:invitationId',
    { preHandler: app.requirePermission('member.invite') },
    async (request, reply) => {
      const { invitationId } = invitationIdParam.parse(request.params);
      const { organizationId } = request.membership!;

      // Scoped by organizationId as well as id: without it, a valid invitation
      // id from another tenant would be revocable from here.
      const result = await prisma.invitation.updateMany({
        where: { id: invitationId, organizationId, status: 'PENDING' },
        data: { status: 'REVOKED', revokedAt: new Date() },
      });
      if (result.count === 0) throw new NotFoundError('Invitation');

      await record(prisma, {
        organizationId,
        actorId: request.auth!.userId,
        action: 'invitation.revoked',
        entityType: 'invitation',
        entityId: invitationId,
        ipAddress: request.ip,
        requestId: request.id,
      });

      return reply.status(204).send();
    },
  );

  /**
   * GET /v1/invitations/preview/:token
   *
   * Unauthenticated: the invitee has not signed in yet and needs to see what
   * they were invited to. Returns the organization name, the role, and whether
   * an account already exists for the address — enough to render the right
   * form, and nothing that identifies other members.
   */
  app.get(
    '/v1/invitations/preview/:token',
    { config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } },
    async (request) => {
      const { token } = z.object({ token: z.string().min(20).max(200) }).parse(request.params);

      const invitation = await prisma.invitation.findFirst({
        where: { tokenHash: hashToken(token), status: 'PENDING', expiresAt: { gt: new Date() } },
        select: {
          email: true,
          organization: { select: { name: true, slug: true } },
          role: { select: { key: true, name: true } },
        },
      });
      if (!invitation) throw new NotFoundError('Invitation');

      const existingUser = await prisma.user.findUnique({
        where: { email: invitation.email },
        select: { id: true, passwordHash: true },
      });

      return {
        email: invitation.email,
        organization: invitation.organization,
        role: invitation.role,
        // Tells the UI whether to ask for a password or just a confirmation.
        requiresAccount: !existingUser?.passwordHash,
      };
    },
  );

  /**
   * POST /v1/invitations/accept
   *
   * Unauthenticated — the token is the credential. Handles both an existing
   * user joining and a brand-new account, deciding between them from the
   * invited email rather than from anything the client asserts.
   */
  app.post(
    '/v1/invitations/accept',
    { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const input = acceptInvitationSchema.parse(request.body);

      const invitation = await prisma.invitation.findFirst({
        where: {
          tokenHash: hashToken(input.token),
          status: 'PENDING',
          expiresAt: { gt: new Date() },
        },
        select: {
          id: true,
          email: true,
          organizationId: true,
          roleId: true,
          organization: {
            select: { id: true, name: true, slug: true, timezone: true, currency: true },
          },
        },
      });
      if (!invitation) {
        // One message for expired, revoked, already-accepted and forged tokens.
        // Distinguishing them tells a token-guesser which guesses were close.
        throw new AppError(
          ERROR_CODES.NOT_FOUND,
          404,
          'This invitation is invalid, expired or has already been used.',
        );
      }

      const existingUser = await prisma.user.findUnique({
        where: { email: invitation.email },
        select: { id: true, passwordHash: true },
      });

      const needsAccount = !existingUser?.passwordHash;
      if (needsAccount && (!input.name || !input.password)) {
        throw new ValidationError('Set your name and a password to finish joining.', {
          requiresAccount: true,
        });
      }

      const userId = await prisma.$transaction(async (tx) => {
        let id: string;

        if (existingUser) {
          id = existingUser.id;
          if (needsAccount) {
            await tx.user.update({
              where: { id },
              data: {
                name: input.name!,
                passwordHash: await hashPassword(input.password!),
                status: 'ACTIVE',
                emailVerifiedAt: new Date(),
              },
            });
          }
        } else {
          const created = await tx.user.create({
            data: {
              email: invitation.email,
              name: input.name!,
              passwordHash: await hashPassword(input.password!),
              status: 'ACTIVE',
              // Accepting the invite proves control of the mailbox it was sent
              // to, so a separate verification email would be redundant.
              emailVerifiedAt: new Date(),
            },
            select: { id: true },
          });
          id = created.id;
        }

        const membership = await tx.membership.upsert({
          where: {
            organizationId_userId: { organizationId: invitation.organizationId, userId: id },
          },
          update: { status: 'ACTIVE' },
          create: {
            organizationId: invitation.organizationId,
            userId: id,
            status: 'ACTIVE',
          },
          select: { id: true },
        });

        await assignRole(tx, membership.id, invitation.roleId);

        // Single use. Marking ACCEPTED inside the same transaction means a
        // replayed token finds nothing PENDING and fails.
        await tx.invitation.update({
          where: { id: invitation.id },
          data: { status: 'ACCEPTED', acceptedAt: new Date() },
        });

        await record(tx, {
          organizationId: invitation.organizationId,
          actorId: id,
          action: 'invitation.accepted',
          entityType: 'membership',
          entityId: membership.id,
          metadata: { email: invitation.email, newAccount: !existingUser },
          ipAddress: request.ip,
          requestId: request.id,
        });

        return id;
      });

      const session = await createSession(prisma, {
        userId,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        activeOrganizationId: invitation.organizationId,
      });

      reply.setCookie(SESSION_COOKIE, session.token, sessionCookieOptions(session.expiresAt));

      return reply.status(201).send({ organization: invitation.organization });
    },
  );

  done();
}
