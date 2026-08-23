/**
 * Strip keys whose value is `undefined`.
 *
 * `exactOptionalPropertyTypes` draws a distinction most code ignores: an absent
 * property is not the same as one explicitly set to `undefined`. Prisma cares
 * about the same distinction for a different reason — `{ name: undefined }` in
 * an update means "do not touch name", while a partial object built from
 * optional inputs can carry `undefined` values that are noise rather than
 * intent.
 *
 * Passing the object through here makes "absent" the only representation, so
 * the two systems agree.
 */
export function definedOnly<T extends Record<string, unknown>>(
  input: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key] = value;
  }
  return output as { [K in keyof T]?: Exclude<T[K], undefined> };
}
