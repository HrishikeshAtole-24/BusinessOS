# ADR-001: Modular monolith before microservices

**Status:** Accepted
**Date:** 2026-08-23

## Context

BusinessOS spans People, Work, Finance and Operations. That module list invites
a service-per-module split, and the temptation is strongest at the start, when
splitting is cheapest and the least is known about where the real boundaries lie.

A service boundary earns its keep when something genuinely differs across it:
independent scaling, independent deployment, separate ownership, isolation
requirements, or a different runtime. On day one none of those apply — there is
one developer and no traffic.

## Decision

Build one deployable API as a **modular monolith**, with a separate **worker**
process for asynchronous jobs.

Module boundaries are enforced in code, not by the network:

```
apps/api/src/modules/
  identity/  organization/  access/  people/  work/  finance/  workflow/  platform/
```

A module owns its domain rules and its persistence access. Modules talk through
explicit application interfaces or domain events — never by reaching into
another module's tables (Section 3.2).

The worker is split out from the start because asynchronous work has genuinely
different latency, retry and failure characteristics from a request/response
path. That is a real boundary, so it gets a real process.

## Alternatives

**Microservices from day one.** Buys independent deployability we cannot yet use,
and charges for it immediately in distributed transactions, cross-service
debugging, duplicated models and service discovery. Section 4.2.

**Single process including workers.** Simpler still, but a slow report job would
compete with request handling for the event loop. The split costs little now and
prevents a class of latency problem later.

## Consequences

One deploy target, one database, one transaction boundary — local reasoning stays
possible, and a change spanning three modules is one atomic commit.

The discipline moves from infrastructure to review. Nothing at runtime stops a
module from importing another module's repository; only convention and code
review do. Import-boundary lint rules should be added once module count grows.

Scaling is all-or-nothing: every module scales with the API process.

## Operational impact

Two runtime images (`api`, `worker`) plus the web app. One migration pipeline.
Tracing spans one process for requests and hops to the worker via the queue,
which keeps OpenTelemetry setup (Section 19) simple.

## Review trigger

Extract a service when a specific, observed condition appears — not on module
count. Section 4.3 lists the candidates and their triggers:

| Candidate            | Trigger                                                    |
| -------------------- | ---------------------------------------------------------- |
| Notification service | Sustained outbound volume, or separate ownership           |
| Reporting service    | Analytical load measurably degrading transactional queries |
| Search service       | Full-text or semantic requirements PostgreSQL cannot serve |
| Workflow service     | Automation volume needing independent scaling              |
| AI service           | Model traffic needing GPU/LLM-specific infrastructure      |

"The codebase feels large" is not a trigger.
