# BusinessOS

A multi-tenant B2B company operations platform — People, Work, Finance and
Operations on one shared identity, permission and workflow layer.

The central abstraction is the **Organization**, not the Employee. That is the
line between this and an HRMS: an HRMS answers "who is on leave?", BusinessOS
answers that _and_ "which projects are slipping, which team is overloaded, and
what is waiting on approval?"

Design authority for this repository is
[`docs/reference/BusinessOS_Complete_Technical_Report_v1.0.docx`](docs/reference/BusinessOS_Complete_Technical_Report_v1.0.docx).
Section numbers throughout the code and ADRs refer to it.

---

## Status

Early foundation. Nothing is deployable yet.

|     |                                                             |
| --- | ----------------------------------------------------------- |
| ✅  | Monorepo, pnpm workspace + version catalogue                |
| ✅  | Strict TypeScript presets                                   |
| ✅  | Prisma schema — identity, tenancy, RBAC, invitations, audit |
| ⬜  | First migration (needs a Neon connection string)            |
| ⬜  | Fastify API, Next.js web, BullMQ worker                     |
| ⬜  | Session auth, org creation, invitations                     |
| ⬜  | Permission catalogue and seed                               |
| ⬜  | CI                                                          |

Tracked against the 14-day plan in Section 39 of the report.

---

## Requirements

|            | Version      | Why                                                                             |
| ---------- | ------------ | ------------------------------------------------------------------------------- |
| Node       | **24.x LTS** | [ADR-012](docs/adr/012-node-24-lts.md) — enforced by `.nvmrc` + `engine-strict` |
| pnpm       | **11.x**     | Workspaces and the `catalog:` protocol                                          |
| PostgreSQL | **18**       | Via Neon — [ADR-015](docs/adr/015-managed-dev-datastores.md)                    |
| Redis      | **8.x**      | Via Upstash — same ADR                                                          |

```bash
nvm install 24 && nvm use 24    # then open a NEW shell — see ADR-012
corepack enable pnpm
```

## Setup

```bash
pnpm install
cp .env.example .env            # then fill in Neon + Upstash URLs
pnpm db:generate
pnpm db:migrate
```

`.env.example` explains why Neon gives you **two** connection strings and which
one migrations need. Getting that wrong produces confusing failures, so it is
worth the thirty seconds.

## Layout

```
apps/
  web/         Next.js 16 — App Router
  api/         Fastify 5 — the business boundary
  worker/      BullMQ consumers
packages/
  contracts/   Zod schemas shared across the API boundary
  domain/      Shared domain types
  config/      TypeScript presets
prisma/        Schema, migrations, seed
docs/
  adr/         Architecture Decision Records
  architecture/
  api/
  reference/   The v1.0 technical report and its origin transcript
infra/docker/
```

Per [ADR-001](docs/adr/001-modular-monolith.md) this is a **modular monolith**:
one API process with enforced internal module boundaries, plus a separate worker
because asynchronous work has different failure characteristics. Module
boundaries are maintained by review, not by the network.

## Scripts

|                             |                                     |
| --------------------------- | ----------------------------------- |
| `pnpm dev`                  | Run all apps                        |
| `pnpm typecheck`            | `tsc --noEmit` across the workspace |
| `pnpm lint` / `pnpm format` | ESLint / Prettier                   |
| `pnpm test`                 | Vitest                              |
| `pnpm test:e2e`             | Playwright                          |
| `pnpm db:migrate`           | Create and apply a migration        |
| `pnpm db:studio`            | Browse the database                 |
| `pnpm db:seed`              | Seed permissions and a demo org     |

## Conventions

Tables `snake_case`, API JSON `camelCase`, IDs opaque UUIDv7. Branches
`feat/*`, `fix/*`, `chore/*`. Commits `feat:`, `fix:`, `refactor:`, `test:`,
`docs:`, `chore:`. Full list in Appendix B of the report.

**Two rules with no exceptions:**

1. `organizationId` comes from the authenticated session — never from a request
   body or query parameter (Section 9.3). This is the tenant isolation boundary;
   trusting client input here defeats it entirely.
2. Audit records are append-only. No update path, no delete path (Section 33).

## Versions

Dependency versions are pinned once in the `catalog:` block of
`pnpm-workspace.yaml` and referenced as `catalog:` from each package. Every pin
was checked against the npm registry rather than taken on trust — which is how
[ADR-014](docs/adr/014-typescript-5-9.md) exists: TypeScript 7 is GA, but
`typescript-eslint` does not support it yet, so type-aware linting would silently
stop working.
