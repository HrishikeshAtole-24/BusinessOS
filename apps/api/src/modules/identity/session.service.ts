import { generateToken, hashToken } from '@businessos/domain';
import type { PrismaClient } from '@businessos/database';
import { env } from '../../config/env.js';

/**
 * Server-side session management — report Section 18.2.
 *
 * Sessions are opaque random tokens stored as SHA-256 hashes, not JWTs. The
 * deciding requirement is revocation: Section 18.2 calls for sessions to be
 * revoked on password reset and suspicious activity, and a stateless token
 * cannot be revoked without a denylist — which reintroduces the database lookup
 * that motivated the JWT in the first place.
 */

export interface SessionCreateInput {
  userId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  activeOrganizationId?: string | null;
}

export interface CreatedSession {
  /** Returned to the caller once, set as a cookie, and never stored. */
  token: string;
  expiresAt: Date;
}

export interface ResolvedSession {
  sessionId: string;
  userId: string;
  email: string;
  name: string;
  activeOrganizationId: string | null;
}

export async function createSession(
  prisma: PrismaClient,
  input: SessionCreateInput,
): Promise<CreatedSession> {
  const { plaintext, hash } = generateToken();
  const expiresAt = new Date(Date.now() + env.sessionTtlMs);

  await prisma.session.create({
    data: {
      userId: input.userId,
      tokenHash: hash,
      expiresAt,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent?.slice(0, 512) ?? null,
      activeOrganizationId: input.activeOrganizationId ?? null,
    },
  });

  return { token: plaintext, expiresAt };
}

/**
 * Resolve a session token to its user.
 *
 * Looked up by hash through a unique index, so the comparison is the database's
 * job and runs in constant time regardless of the supplied token.
 *
 * Expiry and revocation are filtered in the query rather than checked after
 * loading, which makes it impossible to forget the check on some future code
 * path that also reads sessions.
 */
export async function resolveSession(
  prisma: PrismaClient,
  token: string,
): Promise<ResolvedSession | null> {
  const session = await prisma.session.findFirst({
    where: {
      tokenHash: hashToken(token),
      revokedAt: null,
      expiresAt: { gt: new Date() },
      // A suspended or deactivated account must lose access immediately,
      // without waiting for its sessions to expire.
      user: { status: 'ACTIVE' },
    },
    select: {
      id: true,
      userId: true,
      activeOrganizationId: true,
      user: { select: { email: true, name: true } },
    },
  });

  if (!session) return null;

  return {
    sessionId: session.id,
    userId: session.userId,
    email: session.user.email,
    name: session.user.name,
    activeOrganizationId: session.activeOrganizationId,
  };
}

/**
 * Update `lastActiveAt`, at most once every few minutes.
 *
 * Writing on every request would turn each authenticated GET into a write and
 * put the sessions table on the hot path of everything. The throttle is why
 * this takes the last-known value rather than reading the row again.
 */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export async function touchSession(
  prisma: PrismaClient,
  sessionId: string,
  lastActiveAt: Date,
): Promise<void> {
  if (Date.now() - lastActiveAt.getTime() < TOUCH_INTERVAL_MS) return;
  await prisma.session.update({
    where: { id: sessionId },
    data: { lastActiveAt: new Date() },
  });
}

/**
 * Set the tenant this session is acting in.
 *
 * The caller must have verified membership first. This function trusts its
 * input, which is why it is not exported to route handlers directly — the
 * organization module owns the membership check that precedes it.
 */
export async function setActiveOrganization(
  prisma: PrismaClient,
  sessionId: string,
  organizationId: string | null,
): Promise<void> {
  await prisma.session.update({
    where: { id: sessionId },
    data: { activeOrganizationId: organizationId },
  });
}

/**
 * Revoke by marking, not deleting.
 *
 * A deleted row cannot answer "when was this session revoked, and from what IP
 * was it last used?" — which is the first question asked during an incident.
 */
export async function revokeSession(prisma: PrismaClient, sessionId: string): Promise<void> {
  await prisma.session.update({
    where: { id: sessionId },
    data: { revokedAt: new Date() },
  });
}

/**
 * Revoke every live session for a user.
 *
 * Section 18.2: "revoke sessions on suspicious activity or password reset."
 * This is the break-glass action, and it is also what a "sign out everywhere"
 * control calls.
 */
export async function revokeAllUserSessions(
  prisma: PrismaClient,
  userId: string,
  exceptSessionId?: string,
): Promise<number> {
  const result = await prisma.session.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
    },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

/**
 * Cookie attributes — the difference between a session and a stolen session.
 *
 *   httpOnly  JavaScript cannot read it, so an XSS bug cannot exfiltrate it.
 *   secure    HTTPS only (disabled in development, where there is no TLS).
 *   sameSite  'lax' blocks the cookie on cross-site POSTs, which stops the
 *             common CSRF shape while still allowing normal top-level
 *             navigation into the app from an email link.
 *   path      '/' so it accompanies every API route.
 */
export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: 'lax' as const,
    path: '/',
    expires: expiresAt,
  };
}

export const SESSION_COOKIE = env.SESSION_COOKIE_NAME;
