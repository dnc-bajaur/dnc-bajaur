# ADR-0003 — Ownership and override are data, not `if` statements

**Status:** Accepted
**Date:** 2026-08-01
**Reversal cost:** High — touches every authorisation site

## Context

The root idea contains a requirement that sounds trivial and is not:

> Departments own their data. Central administration can view everything and edit some of
> it. There is one record, not two copies.

Implemented conventionally, this becomes role comparisons scattered across controllers:
`if (user.role === 'central' || user.department === record.department)`. Within a month
there are forty such checks, no two quite alike, and no one can answer "who is allowed to
change incident severity?" without reading the codebase.

Worse, the rules are exactly the thing departments and the DC office will negotiate over.
They must be **inspectable and changeable by someone who is not a programmer** — otherwise
every policy adjustment is a release.

## Decision

Authority is a database table. Every writable field carries a rule:

```
field_key              e.g. "incident.severity"
owner_role             who owns it
override_authority[]   which seats or tiers may override
reason_required        boolean
visible_to_owner       none | yes | yes_and_notify
```

Three rules govern its behaviour:

1. **An override is an event, not an edit.** The department's original value survives and
   remains visible. The override wins in the projection; both are rendered.
2. **Concurrency resolves by authority, then time.** The higher authority wins; the loser
   surfaces as a visible conflict, never a silent discard.
3. **Provenance is always renderable.** Any value can answer "who set this, when, was it
   overridden, and why" — because that is the record, not a report derived from it.

Full policy table and the break-glass escape hatch: `04-authority-model.md`.

## Rationale

Ownership and authority are different concepts, and conflating them is what causes the
rot. The department *owns* incident severity; the control room has *authority* to override
it. Both are true at once, and the system must say which applied to any value at any
moment.

Making the rules data means they can be tested exhaustively (every row generates a test),
audited by non-programmers, and changed without a deployment. It also means adding a new
department is rows, not a release.

Making overrides additive rather than destructive means nobody can be blamed for a number
they did not enter — which matters enormously for adoption. A department that fears its
assessments will be silently rewritten will stop entering honest assessments.

## Consequences

### We gain
- One place to answer "who may change this?", inspectable by an administrator.
- Exhaustive authorisation tests generated from the policy table.
- Override provenance for free, satisfying INV-06.
- New departments as configuration (`ADR-0007` extensibility goal).

### We give up
- Indirection. A developer reading a mutation handler cannot see the rule inline; they
  must consult the policy table.
- Some flexibility for genuinely bespoke rules, which must either fit the model or become
  an explicit exception with its own ADR.

### We must therefore also
- Provide **break-glass**: a DC-tier seat may act outside normal authority, always with a
  reason, logged with maximum prominence, notifying the owning department immediately, and
  reviewed after the fact. An impossible escape hatch gets replaced by shared passwords —
  a visible one is safer than no one.
- Enforce authority server-side only (INV-05). Test every refusal **by direct API call**,
  never through the UI.
- Render provenance in the UI wherever an overridable value appears, or the model's main
  benefit is invisible to users.

## Alternatives considered

**Role-based checks in code.** Rejected: untestable at scale, invisible to
non-programmers, and a release for every policy change.

**A general policy engine (OPA, Cedar, or similar).** Rejected for v1 as disproportionate
to the rule count and against `ADR-0007`'s operability constraint — one more component for
the 02:00 test. Revisit if rules grow beyond what a table expresses clearly.

**Central gets a separate editable copy that syncs back.** Rejected outright — this
violates the root idea's single-source-of-truth requirement and is the specific
anti-pattern the architecture exists to prevent.

## How we would know this was wrong

- The policy table needs more than about five columns to express real rules, meaning
  authority is genuinely more conditional than modelled — at which point a real policy
  engine is warranted.
- Break-glass is used routinely rather than exceptionally, meaning the modelled authority
  does not match how the district actually operates and the table is wrong.
- Departments report that override provenance is confusing rather than reassuring,
  meaning the presentation needs rethinking even if the model is sound.
