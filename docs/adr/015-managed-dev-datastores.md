# ADR-015: Managed Neon + Upstash for development instead of local Docker Compose

**Status:** Accepted
**Date:** 2026-08-23

## Context

Report Section 39 item 5 says "Add Docker Compose for PostgreSQL and Redis", and
Section 21.1 reserves `infra/docker/` for it. That assumes Docker is available on
the development machine. It is not — the Windows development machine has no
Docker Desktop, no `psql`, and no local Redis.

The options were: install Docker Desktop, install PostgreSQL and Redis natively
on Windows, or use managed free-tier services. We chose managed services to get a
working database today rather than spending the session on infrastructure setup.

## Decision

For **development**, use managed datastores:

- **Neon** for PostgreSQL 18 — which also satisfies ADR-013 (PG 18 stable, not 19
  beta) without us having to manage the version.
- **Upstash** for Redis over TLS.

Connection details live in `.env` (gitignored); `.env.example` documents the
shape and, importantly, _why_ Neon hands out two different URLs:

| Variable       | Neon string                | Used by                   |
| -------------- | -------------------------- | ------------------------- |
| `DATABASE_URL` | pooled (`-pooler` in host) | API and worker at runtime |
| `DIRECT_URL`   | unpooled                   | `prisma migrate`          |

Migrations must bypass PgBouncer: DDL and advisory locks do not survive a
transaction-mode pooler, and the resulting failures are hard to read.

`infra/docker/` stays in the tree. This decision is about the _development_
datastore, not about abandoning containers — the app itself is still built to
ship as an image (Section 21.2).

## Alternatives

**Docker Desktop.** The report's intent, and the better long-term answer: a
disposable, reproducible PG + Redis pair, and the only option that makes
Testcontainers-based integration tests (Section 20.1) work as specified. Rejected
for now purely on setup cost — a ~600 MB install and a reboot before writing any
code.

**Native Windows installs.** EDB installer for PostgreSQL, Memurai or WSL for
Redis. No container layer, but it diverges from `infra/docker/` and makes
"reset to a clean database" a manual chore instead of one command.

## Consequences

We get a real PostgreSQL 18 today with no local installation, and Neon branching
is a genuinely nice fit for testing migrations against a copy of real data.

Development now requires network access. An offline train journey means no
database.

**This blocks the testing strategy.** Section 20.1 specifies Vitest +
Testcontainers for integration tests, and Testcontainers needs a container
runtime. Until Docker exists on this machine, integration tests must either run
against a dedicated Neon branch or be deferred. That is a real cost of this
decision, not a footnote — it is the main reason to revisit.

Free-tier limits apply: Neon suspends idle compute (first query after a pause is
slow), and Upstash caps commands per day.

## Operational impact

Development only. Production topology is decided separately and is not
constrained by this ADR.

Credentials now live in a `.env` file rather than in a compose file, so the
"never commit secrets" rule (Section 18.4) has teeth from day one — `.env` is
gitignored, `.env.example` carries placeholders.

## Review trigger

Revisit when **any** of these becomes true:

1. Integration tests are ready to write — Testcontainers needs Docker, and that
   is Section 20's specified path.
2. Free-tier limits start interrupting work.
3. A second developer joins and needs a reproducible local environment.

The likely outcome is a supersede: Docker Compose for local development, with
Neon kept for preview branches.
