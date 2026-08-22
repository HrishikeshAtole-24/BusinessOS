# ADR-012: Node 24 LTS rather than Node 26 Current

**Status:** Accepted
**Date:** 2026-08-23

## Context

The report specifies Node 24 Active LTS over Node 26 Current. Verified:

```
$ npm view node version
26.7.0
```

Node 26 is Current. Node 26 does not enter LTS until it crosses into Active LTS
status; until then it receives semver-major changes on a Current cadence, which
is the opposite of what a system of record wants underneath it.

The development machine had Node 22.22.2 installed — itself an older LTS, but
not the line the report targets.

## Decision

Pin Node 24 LTS. Installed via the already-present nvm-windows:

```
$ nvm install 24 && nvm use 24.19.0
$ node --version
v24.19.0
```

Enforced in three places so a mismatch fails loudly rather than mysteriously:

- `.nvmrc` -> `24.19.0`, so `nvm use` in the repo picks the right line
- `package.json` -> `"engines": { "node": ">=24.0.0 <25.0.0" }`
- `.npmrc` -> `engine-strict=true`, which turns that range from advice into an
  install-time error

## Alternatives

**Node 26 Current.** Newest V8 and newest APIs, with breaking changes arriving
on a Current schedule and a support window that ends sooner. Wrong trade for the
process that owns the database connection.

**Stay on Node 22.** Would have worked for everything scaffolded today, and was
tempting as the zero-effort option. Rejected because the gap only gets more
expensive to close later, and because a `.nvmrc` that disagrees with the actual
runtime is worse than no `.nvmrc`.

## Consequences

Native `node:test`, a stable built-in fetch, and V8 flags matching what CI and
production will run.

Anything requiring a Node 26 API is unavailable. Nothing in the current stack
does.

nvm-windows switches the runtime by repointing a symlink (`C:\nvm4w\nodejs`).
Shells opened _before_ `nvm use` keep resolving the old binary from a cached
PATH — a new shell is needed after switching. Worth knowing before losing time
to it.

## Operational impact

CI pins the same version via `.nvmrc`. Runtime images build from a Node 24 base,
so development, CI and production agree.

## Review trigger

Revisit when Node 26 enters **Active LTS** and the ecosystem — particularly
Prisma's engine binaries — publishes support for it. Check the official schedule
at <https://nodejs.org/en/about/previous-releases> rather than assuming.
