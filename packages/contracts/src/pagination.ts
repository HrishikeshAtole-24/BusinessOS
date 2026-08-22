import { z } from 'zod';
import { AppError, ERROR_CODES } from './errors.js';

/**
 * Cursor (keyset) pagination — report Section 16.1.
 *
 * Why not `OFFSET`: to serve `OFFSET 100000`, PostgreSQL must produce and
 * discard 100 000 rows, so deep pages get linearly slower. Worse for this
 * product, offsets are unstable on mutating lists — insert a row while someone
 * pages through tasks and they see an item twice or miss one entirely.
 *
 * A keyset cursor asks "give me rows after *this specific row*", which is a
 * range scan on an index the query already uses. Constant cost per page, and
 * concurrent inserts cannot shift the window.
 *
 * This works cheaply here because IDs are UUIDv7 (see `prisma/schema.prisma`):
 * v7 embeds a millisecond timestamp in its high bits, so lexical ID order *is*
 * creation order. One indexed column serves as both identity and sort key —
 * no `(created_at, id)` composite tiebreaker needed.
 */

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().min(1).optional(),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Cursors are opaque to clients on purpose. Base64url of a small JSON payload
 * lets the internal shape change (add a sort key, switch direction) without
 * breaking anyone, and discourages clients from constructing them by hand.
 *
 * Opaque is not the same as secure. A cursor is a position, never a capability:
 * every query still filters by `organizationId` from the session. A stolen
 * cursor from another tenant selects nothing.
 */
const cursorPayloadSchema = z.object({
  /** ID of the last row on the previous page. */
  id: z.string().uuid(),
});

export function encodeCursor(lastId: string): string {
  return Buffer.from(JSON.stringify({ id: lastId }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { id: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new AppError(ERROR_CODES.MALFORMED_CURSOR, 400, 'The pagination cursor is not valid.');
  }

  const result = cursorPayloadSchema.safeParse(parsed);
  if (!result.success) {
    throw new AppError(ERROR_CODES.MALFORMED_CURSOR, 400, 'The pagination cursor is not valid.');
  }
  return result.data;
}

/**
 * Build a page from rows fetched with `take: limit + 1`.
 *
 * Fetching one extra row is how `hasMore` is answered without a second
 * `COUNT(*)` query — the count would scan the whole matching set to tell us one
 * boolean. The extra row is trimmed before returning.
 */
export function buildPage<T extends { id: string }>(rows: T[], limit: number): Page<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data.at(-1);

  return {
    data,
    nextCursor: hasMore && last ? encodeCursor(last.id) : null,
    hasMore,
  };
}

/**
 * Prisma arguments for a keyset page.
 *
 * `skip: 1` steps past the cursor row itself, which would otherwise repeat as
 * the first item of every page after the first.
 */
export function toPrismaPageArgs(query: PaginationQuery): {
  take: number;
  skip?: number;
  cursor?: { id: string };
} {
  const take = query.limit + 1;
  if (!query.cursor) return { take };
  return { take, skip: 1, cursor: decodeCursor(query.cursor) };
}
