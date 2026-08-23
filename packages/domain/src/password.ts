import { hash, verify } from '@node-rs/argon2';

/**
 * Password hashing — report Section 18.2 ("hash passwords with Argon2id").
 *
 * Argon2id rather than bcrypt because it is deliberately **memory**-hard, not
 * just CPU-hard. Attacking bcrypt scales cheaply on GPUs and ASICs, which have
 * enormous parallelism but little memory per core. Forcing each guess to
 * allocate 19 MiB makes that hardware advantage largely evaporate.
 */

/**
 * OWASP's recommended Argon2id baseline: m=19456 (19 MiB), t=2, p=1.
 *
 * The tuning knob is wall-clock time on the target hardware — aim for roughly
 * 100–500ms per hash. Fast enough that a login does not feel slow; slow enough
 * that offline brute-forcing a leaked hash is expensive.
 *
 * These parameters are encoded in the resulting hash string, so raising them
 * later does not invalidate existing hashes: old passwords keep verifying with
 * their original cost, and `needsRehash` identifies which to upgrade on next
 * successful login.
 */
const ARGON2_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  // algorithm 2 = Argon2id, the hybrid variant. Argon2i alone is weaker against
  // time-memory trade-off attacks; Argon2d alone is weaker against side channels.
  algorithm: 2,
} as const;

/**
 * Argon2 salts every hash internally with a fresh random value, so identical
 * passwords never produce identical hashes and one cracked hash does not
 * reveal every account sharing that password. There is no separate salt column.
 */
export async function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, ARGON2_OPTIONS);
}

/**
 * Verify a password.
 *
 * Returns `false` on a malformed or corrupt stored hash rather than throwing.
 * A thrown error here would surface as a 500 while a wrong password returns
 * 401 — and that difference is observable, which makes it an oracle for
 * probing which accounts have unusual hash records.
 */
export async function verifyPassword(storedHash: string, plaintext: string): Promise<boolean> {
  try {
    return await verify(storedHash, plaintext, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

/**
 * Whether a stored hash was produced with weaker parameters than current policy.
 *
 * Call after a *successful* login — that is the only moment the plaintext is
 * available to re-hash with. This is how cost parameters get raised over the
 * years without a forced password reset.
 */
export function needsRehash(storedHash: string): boolean {
  const params = parseArgon2Params(storedHash);
  if (!params) return true; // unrecognised format: replace it

  return (
    params.algorithm !== 'argon2id' ||
    params.memoryCost < ARGON2_OPTIONS.memoryCost ||
    params.timeCost < ARGON2_OPTIONS.timeCost
  );
}

interface Argon2Params {
  algorithm: string;
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

/** Parse the PHC string: `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`. */
function parseArgon2Params(storedHash: string): Argon2Params | null {
  const parts = storedHash.split('$');
  // ['', 'argon2id', 'v=19', 'm=19456,t=2,p=1', salt, hash]
  if (parts.length < 4) return null;

  const algorithm = parts[1];
  const paramSegment = parts[3];
  if (!algorithm || !paramSegment) return null;

  const params: Record<string, number> = {};
  for (const pair of paramSegment.split(',')) {
    const [key, value] = pair.split('=');
    if (key && value) params[key] = Number(value);
  }

  const m = params['m'];
  const t = params['t'];
  const p = params['p'];
  if (m === undefined || t === undefined || p === undefined) return null;

  return { algorithm, memoryCost: m, timeCost: t, parallelism: p };
}
