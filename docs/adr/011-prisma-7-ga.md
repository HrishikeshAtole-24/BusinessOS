# ADR-011: Prisma 7 GA rather than Prisma 8 RC

**Status:** Accepted
**Date:** 2026-08-23

## Context

The report (Appendix A) records Prisma 7 as GA and Prisma 8 as a release
candidate, and directs the project at the GA line. Verified before pinning:

```
$ npm view prisma version
7.9.1
$ pnpm exec prisma --version
prisma          : 7.9.1
Query Compiler  : enabled
```

`7.9.1` is `latest` on the registry, so the report holds.

Prisma 7 is a substantial change from 6.x in two ways that affect this repo:

1. The default generator is `prisma-client` (not `prisma-client-js`), and it
   emits to a real directory — here `generated/prisma` — rather than into
   `node_modules`. That directory is gitignored and regenerated.
2. The datasource URL has moved out of `schema.prisma` into `prisma.config.ts`.
   The URL is now ordinary TypeScript, so it can be validated at load time
   instead of failing later inside the driver.

## Decision

Pin `prisma` and `@prisma/client` to exactly `7.9.1`.

## Alternatives

**Prisma 8 RC.** Release candidate. The report's baseline rule (Section 5)
excludes prereleases from production dependencies, and an ORM is the single
worst place to absorb breaking changes mid-build.

**Drizzle, Kysely, or raw SQL.** Reasonable choices, and closer to the SQL that
Section 10.3 wants us reasoning about. But the report commits to Prisma, and its
migration tooling plus generated types carry real weight for a solo build.
Revisiting this is a bigger decision than a version pin.

## Consequences

Type-safe database access and a migration workflow that works with Neon, given
the `directUrl` split (ADR-015).

Prisma's query builder is not SQL. Where a query needs a plan we can reason about
(Section 10.3: "use `EXPLAIN (ANALYZE, BUFFERS)`"), `$queryRaw` with a checked-in
`EXPLAIN` output is the honest tool — the ORM should not hide the plan.

`generated/` must exist before typecheck. CI runs `prisma generate` before
`tsc`, and so must a fresh clone.

## Operational impact

`prisma migrate deploy` runs in the release pipeline before the new image serves
traffic (Section 21.3). Migrations use `DIRECT_URL`, runtime uses the pooled
`DATABASE_URL`.

## Review trigger

Revisit when Prisma 8 reaches GA and has had a stable patch line — not on the
day it ships. Re-read the upgrade guide before moving; ORM majors have moved
schema syntax before.
