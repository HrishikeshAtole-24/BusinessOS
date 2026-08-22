import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  buildPage,
  decodeCursor,
  encodeCursor,
  paginationQuerySchema,
  toPrismaPageArgs,
} from './pagination.js';

const uuid = (n: number) => `0199c8b0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const rows = (count: number) => Array.from({ length: count }, (_, i) => ({ id: uuid(i) }));

describe('cursor encoding', () => {
  it('round-trips an id', () => {
    const id = uuid(42);
    expect(decodeCursor(encodeCursor(id)).id).toBe(id);
  });

  it('produces a URL-safe cursor', () => {
    // base64url, so a cursor can sit in a query string untouched. Standard
    // base64 would need escaping and would break on the first `+` or `/`.
    expect(encodeCursor(uuid(1))).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('rejects malformed cursors with a 400, not a crash', () => {
    for (const bad of ['not-base64!!', '', 'eyJmb28iOiJiYXIifQ', btoa('{"id":"nope"}')]) {
      expect(() => decodeCursor(bad), `cursor: ${bad}`).toThrow();
    }
  });

  it('rejects a cursor whose id is not a uuid', () => {
    // Guards the query: an unvalidated cursor value flows into a `where` clause.
    const forged = Buffer.from(JSON.stringify({ id: "'; DROP TABLE users;--" })).toString(
      'base64url',
    );
    expect(() => decodeCursor(forged)).toThrow(/not valid/);
  });
});

describe('paginationQuerySchema', () => {
  it('defaults limit when absent', () => {
    expect(paginationQuerySchema.parse({}).limit).toBe(DEFAULT_PAGE_SIZE);
  });

  it('coerces the string a query parameter actually arrives as', () => {
    expect(paginationQuerySchema.parse({ limit: '50' }).limit).toBe(50);
  });

  it('caps limit so a client cannot request an unbounded page', () => {
    expect(paginationQuerySchema.safeParse({ limit: MAX_PAGE_SIZE + 1 }).success).toBe(false);
    expect(paginationQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
  });
});

describe('buildPage', () => {
  it('trims the probe row and reports hasMore', () => {
    // Fetched with take: limit + 1 — the extra row answers hasMore without a
    // second COUNT(*) over the whole matching set.
    const page = buildPage(rows(11), 10);
    expect(page.data).toHaveLength(10);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).not.toBeNull();
  });

  it('reports the end of the list when no probe row came back', () => {
    const page = buildPage(rows(7), 10);
    expect(page.data).toHaveLength(7);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('handles an empty result', () => {
    const page = buildPage([], 10);
    expect(page).toEqual({ data: [], nextCursor: null, hasMore: false });
  });

  it('points nextCursor at the last returned row, not the probe row', () => {
    // Getting this wrong skips a record on every page boundary — the classic
    // keyset off-by-one, and invisible until someone audits missing data.
    const page = buildPage(rows(11), 10);
    expect(decodeCursor(page.nextCursor!).id).toBe(uuid(9));
  });
});

describe('toPrismaPageArgs', () => {
  it('takes one extra row and does not skip on the first page', () => {
    expect(toPrismaPageArgs({ limit: 25 })).toEqual({ take: 26 });
  });

  it('skips the cursor row itself on subsequent pages', () => {
    // Without skip: 1 the cursor row repeats as the first item of every page.
    const args = toPrismaPageArgs({ limit: 25, cursor: encodeCursor(uuid(5)) });
    expect(args).toEqual({ take: 26, skip: 1, cursor: { id: uuid(5) } });
  });
});

describe('page traversal', () => {
  it('walks a dataset exactly once, with no gaps or repeats', () => {
    const all = rows(23);
    const limit = 10;
    const seen: string[] = [];
    let cursor: string | undefined;

    for (let guard = 0; guard < 10; guard += 1) {
      const args = toPrismaPageArgs({ limit, ...(cursor ? { cursor } : {}) });
      const start = args.cursor ? all.findIndex((r) => r.id === args.cursor!.id) + 1 : 0;
      const page = buildPage(all.slice(start, start + args.take), limit);

      seen.push(...page.data.map((r) => r.id));
      if (!page.hasMore) break;
      cursor = page.nextCursor!;
    }

    expect(seen).toEqual(all.map((r) => r.id));
    expect(new Set(seen).size).toBe(all.length);
  });
});
