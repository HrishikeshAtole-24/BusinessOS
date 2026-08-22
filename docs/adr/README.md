# Architecture Decision Records

One file per meaningful architectural choice, using the template in
[`_template.md`](./_template.md) (report Section 31.1).

Per the Definition of Done (Section 36), an ADR is written **when the decision is
actually implemented** — not banked upfront. ADRs 001–013 were pre-decided in the
v1.0 technical report; each gets its own file as the corresponding code lands.
Rows marked _report_ are agreed in principle but not yet exercised by code.

| ADR                                    | Decision                                               | Status              |
| -------------------------------------- | ------------------------------------------------------ | ------------------- |
| [001](./001-modular-monolith.md)       | Modular monolith before microservices                  | Accepted            |
| 002                                    | PostgreSQL is the source of truth                      | _report_            |
| 003                                    | Shared-schema multi-tenancy with tenant keys           | Accepted (schema)   |
| 004                                    | REST + OpenAPI for the primary API                     | _report_            |
| 005                                    | Redis for cache/ephemeral state, not primary data      | _report_            |
| 006                                    | BullMQ for asynchronous jobs                           | _report_            |
| 007                                    | Transactional outbox for important events              | _report_            |
| 008                                    | Cursor pagination for large mutable lists              | _report_            |
| 009                                    | State machines for business lifecycle transitions      | _report_            |
| 010                                    | OpenTelemetry for traces and metrics                   | _report_            |
| [011](./011-prisma-7-ga.md)            | Prisma 7 GA rather than Prisma 8 RC                    | Accepted            |
| [012](./012-node-24-lts.md)            | Node 24 LTS rather than Node 26 Current                | Accepted            |
| 013                                    | PostgreSQL 18 stable rather than 19 beta               | Accepted (via Neon) |
| [014](./014-typescript-5-9.md)         | TypeScript 5.9 despite TypeScript 7 being GA           | Accepted            |
| [015](./015-managed-dev-datastores.md) | Managed Neon + Upstash instead of local Docker Compose | Accepted            |

## Numbering

Sequential, never reused. A superseded ADR keeps its number and its file; the
replacement links back to it. Deleting an ADR erases the reasoning that a future
reader needs most.
