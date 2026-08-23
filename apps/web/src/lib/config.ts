/**
 * Isomorphic configuration.
 *
 * Deliberately free of imports. `lib/api.ts` imports `next/headers`, which is
 * server-only — a Client Component importing anything from that module pulls
 * `next/headers` into the browser bundle and the build fails.
 *
 * Splitting the constants out means both sides can read them without dragging
 * the server runtime along.
 *
 * NEXT_PUBLIC_ prefix: only variables with it are inlined into client bundles.
 * That prefix is a deliberate opt-in to being public, so nothing secret may
 * carry it.
 */
export const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:4000';
