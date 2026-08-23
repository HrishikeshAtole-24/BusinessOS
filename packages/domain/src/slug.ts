/**
 * Slug generation for tenant-local URL identifiers.
 */

/**
 * Turn a display name into a candidate slug.
 *
 * The NFD normalize + combining-mark strip converts accented characters to
 * their base letters ("Café Étoile" -> "cafe-etoile") instead of dropping them,
 * which would leave "caf-toile".
 */
export function slugify(input: string): string {
  return (
    input
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64)
      // Trailing hyphen can reappear after the slice.
      .replace(/-+$/g, '')
  );
}

/**
 * Find a free slug near the desired one.
 *
 * `isTaken` is injected rather than querying here so this stays pure and
 * testable, and so the caller controls the transaction the check runs in.
 *
 * Suffixes are numeric and sequential rather than random: "acme-2" is
 * predictable and readable, which matters for something that appears in a URL.
 * The database unique constraint remains the real guarantee — this loop only
 * avoids the common collision, and a concurrent create can still lose the race
 * and surface as a 409.
 */
export async function findAvailableSlug(
  desired: string,
  isTaken: (candidate: string) => Promise<boolean>,
  maxAttempts = 50,
): Promise<string> {
  const base = slugify(desired) || 'org';

  if (!(await isTaken(base))) return base;

  for (let n = 2; n <= maxAttempts; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    if (!(await isTaken(candidate))) return candidate;
  }

  // Exhausted the readable options; fall back to something certainly unique.
  return `${base.slice(0, 57)}-${Date.now().toString(36).slice(-6)}`;
}
