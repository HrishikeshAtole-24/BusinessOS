# ADR-014: Pin TypeScript 5.9 despite TypeScript 7 being GA

**Status:** Accepted
**Date:** 2026-08-23

## Context

The v1.0 technical report (Section 5, Appendix A) specifies TypeScript 5.9. When
we checked the npm registry before pinning, the picture had moved:

```
$ npm view typescript dist-tags
{ beta: '6.0.0-beta', rc: '7.0.1-rc', latest: '7.0.2', next: '7.1.0-dev...' }
```

TypeScript **7.0.2** is GA — the native Go port of the compiler, with the large
type-checking speedup that comes with it. TypeScript 6.0 never left beta; the
line went 5.9 → 6.0-beta → 7.0. So "the latest stable TypeScript" is 7.0, not
5.9, and the report is nominally out of date.

The blocker is the lint toolchain:

```
$ npm view typescript-eslint peerDependencies
{ eslint: '^8.57.0 || ^9.0.0 || ^10.0.0', typescript: '>=4.8.4 <6.1.0' }
```

`typescript-eslint@8.67.0` is the current release and it declares a peer range
that **excludes TypeScript 7**. There is no v9 line — the only prerelease tags
are `rc-v8` and `canary`, both still on the v8 series. Adopting TS 7 today means
running with no type-aware linting at all, which would silently delete a whole
category of rules (`no-floating-promises`, `no-misused-promises`,
`await-thenable`) that this codebase leans on heavily: the API is asynchronous
almost end to end.

TypeScript 6.0 is not an escape hatch either — it is still beta, and the report's
own baseline rule (Section 5) rules out betas.

## Decision

Pin `typescript@5.9.3` exactly, in the workspace catalogue.

This preserves the report's stated version while updating its _reasoning_. The
report justified 5.9 as "the current stable line". That justification is now
wrong. The choice survives on a different and stronger one: **5.9 is the newest
TypeScript that the type-aware lint ecosystem supports.**

## Alternatives

**TypeScript 7.0.2 with linting downgraded to syntax-only.** Fastest compiler,
but drops every type-aware rule. For a codebase whose main hazard is unawaited
promises crossing a transaction boundary, that trade is backwards.

**TypeScript 7.0.2 with `typescript-eslint` peer warnings suppressed.** The peer
range is not advisory — the v8 parser reads TypeScript internal APIs that the Go
port reorganised. It does not merely warn, it breaks.

**TypeScript 6.0.0-beta.** Prerelease, and it is a deprecation-only staging
release whose whole purpose is easing the move to 7. Adopting it means paying the
migration cost twice.

## Consequences

Type-aware linting keeps working, and `strict` plus the four extra flags in
`packages/config/tsconfig.base.json` stay enforceable.

We give up the native compiler's speed. At current repo size that is invisible;
it will start to matter somewhere past a few hundred modules.

We take on a deferred migration. TS 7 removes deprecated behaviour, so the jump
will not be free. Writing strict, modern TypeScript now is what keeps it small.

Prisma is unaffected — `prisma@7.9.1` declares `typescript: >=5.4.0`, satisfied
by 5.9.3.

## Operational impact

None at runtime. TypeScript is a build-time dependency only; nothing about the
deployed artifact changes.

## Review trigger

Revisit when **`typescript-eslint` ships a release whose peer range admits
TypeScript 7** — that is the single gating condition. Check with:

```bash
npm view typescript-eslint peerDependencies
```

At that point re-evaluate, and supersede this ADR rather than editing it.
