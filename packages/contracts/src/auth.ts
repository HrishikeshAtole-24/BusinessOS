import { z } from 'zod';
import type { PermissionKey } from './permissions.js';

/**
 * Request/response contracts for identity, tenancy and invitations.
 *
 * These schemas are the API's trust boundary. Section 18.4: "validate every
 * request at the boundary" — a handler should never see a field these schemas
 * have not vouched for.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * Email is lowercased and trimmed here, once, so the uniqueness constraint and
 * every lookup agree. Without normalization `Hrishi@x.com` and `hrishi@x.com`
 * become two accounts, and the second one is a quiet account-takeover vector on
 * any flow that matches by email.
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(320)
  .email('Enter a valid email address');

/**
 * Password policy follows OWASP: length is what matters, composition rules are
 * theatre. A 12-character passphrase beats `P@ssw0rd!` comfortably, and
 * mandatory symbol rules mostly produce predictable substitutions.
 *
 * The 72-byte ceiling is bcrypt's limit rather than Argon2's; we are not using
 * bcrypt, but capping input also bounds the work an attacker can force us to do
 * per request.
 */
export const passwordSchema = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(72, 'Use at most 72 characters');

/**
 * Tenant-local URL identifier. Lowercase alphanumeric and single hyphens, never
 * leading or trailing. Length floor of 3 keeps the namespace usable.
 */
export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Use at least 3 characters')
  .max(64)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'Use lowercase letters, numbers and single hyphens between them',
  );

/**
 * Slugs that would collide with a route segment or impersonate the platform.
 * Checked here rather than only at the database, so the user gets a field-level
 * message instead of a 409.
 */
export const RESERVED_SLUGS = new Set([
  'admin',
  'api',
  'app',
  'auth',
  'billing',
  'businessos',
  'dashboard',
  'docs',
  'health',
  'help',
  'login',
  'logout',
  'new',
  'onboarding',
  'settings',
  'signup',
  'static',
  'support',
  'system',
  'www',
]);

export const organizationSlugSchema = slugSchema.refine(
  (value) => !RESERVED_SLUGS.has(value),
  'That name is reserved. Pick another.',
);

export const nameSchema = z.string().trim().min(1, 'Required').max(120);

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export const signupSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  password: passwordSchema,
  /** Optional: create an organization in the same step. */
  organizationName: z.string().trim().min(2).max(160).optional(),
});
export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  // Deliberately NOT `passwordSchema`. Validating a login password against the
  // current policy would reject accounts created under an older one, and would
  // leak the policy to anyone probing the endpoint.
  password: z.string().min(1, 'Required').max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

// ---------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(2, 'Use at least 2 characters').max(160),
  slug: organizationSlugSchema.optional(),
  timezone: z.string().trim().min(1).max(64).default('Asia/Kolkata'),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .length(3, 'Use a 3-letter ISO 4217 code')
    .default('INR'),
});
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;

export const updateOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
  currency: z.string().trim().toUpperCase().length(3).optional(),
  /**
   * Optimistic concurrency (Section 11.2). The client echoes the version it
   * read; a stale value matches no row and returns 409 rather than silently
   * overwriting a concurrent edit.
   */
  version: z.number().int().min(0),
});
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

export const createInvitationSchema = z.object({
  email: emailSchema,
  roleKey: z.string().trim().min(1).max(64),
});
export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;

/**
 * Accepting an invite covers two cases: an existing user joining, and a new
 * user whose account is created by the acceptance itself. `name` and `password`
 * are required only in the second case, which the service determines from the
 * invited email — not from a client-supplied flag.
 */
export const acceptInvitationSchema = z.object({
  token: z.string().min(20).max(200),
  name: nameSchema.optional(),
  password: passwordSchema.optional(),
});
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
}

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  currency: string;
}

/**
 * The `/v1/auth/me` payload — everything the web app needs to render a shell
 * without a second round trip: who you are, which tenant you are acting in,
 * what you may do, and which tenants you could switch to.
 */
export interface SessionContext {
  user: AuthenticatedUser;
  organization: OrganizationSummary | null;
  /** Effective permissions in the active organization. Empty when none is active. */
  permissions: PermissionKey[];
  roles: string[];
  /** Every organization this user belongs to, for the switcher. */
  memberships: OrganizationSummary[];
}
