# ADR-016: Hand-written CSS instead of Tailwind or a component library

**Status:** Accepted
**Date:** 2026-08-24

## Context

Section 5 of the technical report specifies "Tailwind CSS + accessible component
system", and the origin transcript suggests shadcn/ui. The project owner has
since decided against both: **no Tailwind, no Bootstrap, no component library.**

The stated reason is worth recording, because it changes what the project is
for. BusinessOS exists to demonstrate engineering depth. A UI assembled from
`shadcn add` commands demonstrates that a generator was run. Layout, spacing,
theming, focus states and responsive behaviour written by hand demonstrate that
the underlying CSS is understood — which is a fair thing for an interviewer to
probe, and an unfair thing to bluff.

## Decision

All styling is hand-written CSS, organised as:

```
src/styles/
  tokens.css      design tokens: colour, spacing, type, radius, elevation
  base.css        reset, element defaults, focus-visible policy
  layout.css      app shell, sidebar, page grid
  components.css  buttons, inputs, tables, badges, dialogs
```

Loaded once in the root layout. Component-scoped styles use **CSS Modules**
where a rule genuinely belongs to one component; anything reused lives in
`components.css`.

Rules that follow from this:

- **Design tokens are CSS custom properties.** One `--space-3`, one
  `--color-danger`. Hard-coded hex values and magic pixel numbers in component
  files are the thing tokens exist to prevent.
- **Layout uses Grid and Flexbox**, not a float or a 12-column framework grid.
- **Dark and light themes** come from redefining tokens under
  `prefers-color-scheme` and a `[data-theme]` override, never from duplicated
  rulesets.
- **Focus states are visible.** `:focus-visible` on every interactive element
  (Section 24.3). Removing outlines without replacing them is not permitted.
- **Status is never carried by colour alone** — Section 24.3 again. Colour plus
  text or an icon.

## Alternatives

**Tailwind CSS.** Fast, well-trodden, and what the report specified. Rejected
because utility classes move styling decisions into markup rather than teaching
the cascade, which is the opposite of this project's purpose. It is the right
default for a team shipping under deadline; this is not that.

**shadcn/ui or Radix + Tailwind.** Would deliver accessible primitives —
genuinely hard things like focus trapping and ARIA wiring — essentially free.
The cost is that the most instructive parts of the UI arrive pre-solved. We take
on writing them, and take on getting them right.

**CSS-in-JS (styled-components, Emotion).** Adds a runtime and complicates React
Server Components, which Section 24.1 leans on. No.

## Consequences

Full control, no build-time CSS framework, and a small stylesheet containing
only rules we actually use.

Accessible primitives are now **our** responsibility: dialog focus trapping,
`aria-expanded` on disclosure controls, roving tabindex in menus, live regions
for async status. These are easy to get subtly wrong and are exactly what
Section 24.3 requires. Each interactive component needs keyboard testing, not
just mouse testing.

Development is slower per component. That is the accepted trade.

Consistency now depends on discipline rather than on a compiler. The token file
is the guard rail; a review that lets a raw `#3ecf8e` into a component file has
failed.

## Operational impact

Slightly smaller CSS payload and one fewer build-time dependency. No change to
deployment.

## Review trigger

Revisit if hand-written accessible components start consuming time that belongs
to the backend — the backend is where this project's value concentrates. If that
happens, the proportionate response is adopting **headless** primitives (Radix,
React Aria) for focus and ARIA behaviour while keeping all visual styling hand
written, not adopting a styling framework.
