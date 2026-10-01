# ADR-0009 — "Unassessed" is not a severity level

**Status:** Accepted · 2026-08-01
**Supersedes:** nothing. Resolves **Q-16**.

## Context

`POST /incidents` cannot refuse a report (M0-24, INV-01). Someone is telling us an emergency
is happening; a validation error returned to a caller under stress is an emergency the system
chose to lose. So intake has to store *something* when no severity was stated.

The first implementation assumed `high` and recorded `assumed: ['severity']` in the payload.
That was defensible — `low` lets an unassessed emergency sink below routine work, which is
INV-04 by the back door, and `critical` teaches operators to discount the top of the scale —
but it has one fatal property: **on a screen, an assumption is indistinguishable from an
assessment.** A board shows `HIGH`, an operator reads it as somebody's judgement, and the
`assumed` flag lives in a payload nobody renders.

That is the exact failure this project exists not to build. It is the same class as a cached
`/sync` response and as `navigator.onLine`: a value the system invented, presented as a fact
someone established.

## Decision

**`unknown` is a value of `Severity`, and it is never treated as a level.**

1. `Severity = AssessedSeverity | 'unknown'`, where `AssessedSeverity` is the four real
   levels. `SEVERITY_ORDER` continues to contain **only** the four. There is no rank for
   `unknown`, because a rank is exactly the thing it does not have.
2. **Aggregates report two numbers, never one.** `worstSeverity` and `districtSeverity`
   return `{ worst, unassessed }`. An unassessed incident is never folded into a level in
   either direction — not as `low` (which hides it) and not as `critical` (which drowns the
   real ones).
3. **Intake records `unknown`** rather than assuming a level. `assumed: ['severity']` stays
   in the payload as the audit fact.
4. **The SLA for `unknown` is the `high` target.** An unassessed report must reach a human
   quickly — that is the whole reason the old code guessed `high` — but it now does so
   through the deadline, where it belongs, instead of through a value that lies on a screen.
5. **Triage cannot set `unknown`.** Triage is the act of assessing; an operator revising an
   assessment to "no assessment" is not a thing, and the command parser refuses it.

## Consequences

**Good**

- A board can show `3 critical · 2 unassessed` and both numbers are true. Under the old
  design the second group was invisible, sitting inside the `high` count.
- ADR-0005 ("silence is a signal") now holds for severity, not only for reporting. An absent
  assessment is rendered as absent.
- INV-04 gets stronger, not weaker: an aggregate cannot hide a critical *and* cannot hide an
  unassessed incident behind a level someone will read as considered.

**Costs, accepted**

- Every consumer of an aggregate handles two numbers. That is the point — the shape of the
  return type is what stops the next screen from quietly picking one.
- `SlaTargets` gains a row that is not a level. Slightly odd to read; correct in effect.
- One more state for the UI to render. Cheaper than the alternative, which is an operator
  trusting a number nobody chose.

**Rejected alternatives**

- *Keep assuming `high`, render the `assumed` flag on the board.* Puts the burden on every
  screen forever, and the first screen that forgets it silently reintroduces the bug.
- *Rank `unknown` below `low`.* Hides it — INV-04 by the back door.
- *Rank `unknown` above `critical`.* Every unassessed report becomes the district's headline
  severity, and the aggregate stops meaning anything within a week.
- *Make severity nullable instead of adding a value.* Same information, but `null` invites
  `?? 'low'` at every call site, and the type system stops helping.
