import { redirect } from 'next/navigation';
import type { SessionContext } from '@businessos/contracts';
import { apiFetchOrNull } from './api';

/**
 * Read the current session from the API.
 *
 * One call returns identity, active tenant, effective permissions and the
 * organizations available to switch to — everything the shell needs, without a
 * waterfall of requests.
 */
export async function getSession(): Promise<SessionContext | null> {
  return apiFetchOrNull<SessionContext>('/v1/auth/me');
}

/**
 * Require a signed-in user with an active organization.
 *
 * This is a UX convenience, not a security control. Every API route enforces
 * its own guards; a redirect here only saves the user from rendering a page
 * whose data calls would all fail. Deleting it would make the app rude, not
 * insecure.
 */
export async function requireSession(): Promise<SessionContext> {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!session.organization) redirect('/onboarding');
  return session;
}

/** Permission check for conditional UI. */
export function can(session: SessionContext, permission: string): boolean {
  return session.permissions.includes(permission as never);
}

/** Initials for an avatar, from a display name. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2);
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`;
}
