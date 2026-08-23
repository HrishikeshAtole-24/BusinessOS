import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Opaque security tokens — session cookies, invitation links, password resets.
 *
 * Deliberately not JWTs. A JWT would let us skip a database lookup, but this
 * system needs revocation to be immediate: Section 18.2 requires sessions to be
 * revocable on password reset and suspicious activity. A stateless token stays
 * valid until it expires, so revoking it means keeping a denylist — which is a
 * database lookup, the very thing the JWT was meant to avoid, with worse
 * failure modes.
 */

/**
 * 32 bytes = 256 bits of entropy from the OS CSPRNG.
 *
 * `randomBytes`, never `Math.random()`. `Math.random()` is a deterministic PRNG
 * whose internal state can be recovered from a handful of outputs, so tokens
 * built on it are predictable — the classic session-prediction vulnerability.
 */
const TOKEN_BYTES = 32;

export interface GeneratedToken {
  /** Sent to the user. Exists in memory once, and is never stored. */
  plaintext: string;
  /** Stored in the database. */
  hash: string;
}

/**
 * Generate a token and its storage hash.
 *
 * Only the hash is persisted, so a database leak yields no usable sessions or
 * invitation links — the same reasoning that applies to passwords.
 *
 * Unlike a password, this is a plain SHA-256 rather than Argon2. That is
 * deliberate and not a weakening: a password is low-entropy and human-chosen,
 * so it needs a slow hash to make guessing expensive. A 256-bit random token is
 * not guessable at any speed, and hashing it on every request would add latency
 * to every authenticated call for no security gain.
 */
export function generateToken(): GeneratedToken {
  const plaintext = randomBytes(TOKEN_BYTES).toString('base64url');
  return { plaintext, hash: hashToken(plaintext) };
}

export function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of two token hashes.
 *
 * `===` on strings short-circuits at the first differing byte, so its runtime
 * leaks how many leading characters matched. That is enough to reconstruct a
 * secret byte by byte given enough attempts.
 *
 * The usual path looks up by hash and lets the database's unique index do the
 * work, so this is for the cases that compare in application code.
 */
export function tokensMatch(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on length mismatch, and the throw itself would leak
  // length. Compare lengths first and still run the comparison, so the
  // rejection path costs roughly the same as the acceptance path.
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/**
 * Expiry helper. Centralised so token lifetimes are visible in one place rather
 * than scattered as magic numbers.
 */
export function expiresIn(milliseconds: number, from: Date = new Date()): Date {
  return new Date(from.getTime() + milliseconds);
}

export const TOKEN_LIFETIMES = {
  /** Long enough to avoid daily re-login; short enough that theft has a horizon. */
  SESSION_MS: 7 * 24 * 60 * 60 * 1000,
  /** Invitations are an out-of-band artifact sitting in an inbox; expire them. */
  INVITATION_MS: 7 * 24 * 60 * 60 * 1000,
  /** Short: a reset link is the single most valuable token in the system. */
  PASSWORD_RESET_MS: 60 * 60 * 1000,
  EMAIL_VERIFICATION_MS: 24 * 60 * 60 * 1000,
} as const;
