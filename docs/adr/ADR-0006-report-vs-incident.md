# ADR-0006 — One incident, many reports

**Status:** Accepted
**Date:** 2026-08-01
**Reversal cost:** High — core entity split

## Context

A road accident on the Khar–Nawagai road will be reported by five people in four minutes
through three channels — a passer-by on the app, two callers to the control room, an SMS,
and the Rescue station that was already dispatched.

If each becomes an incident:

- The central board floods with five entries for one event, obscuring everything else.
- Five routing decisions fire, five notification cascades hit the same duty officer.
- Response-time metrics are destroyed — four incidents show instant "resolution" as
  duplicates, one shows the real time.
- Nobody can tell at a glance how many real emergencies are open.

The naive fix — reject submissions that look like duplicates — is worse, and directly
violates INV-01. A reporter whose submission is rejected does not try again through
another channel; they assume it is handled. An emergency dropped by a duplicate heuristic
is an emergency lost.

## Decision

`Report` and `Incident` are **separate entities**.

- A **Report** is a single claim that something happened. Cheap, **never rejected**, never
  deleted. Any channel, any completeness.
- An **Incident** is the authoritative thing in the world. One or more reports link to it.
- A report arriving with no obvious match creates a new incident. A report matching an
  existing one links to it.
- Matching is **suggested** by a proximity/time/category heuristic and **confirmed by an
  operator**. The system never auto-merges without a human, and never blocks a submission.
- `merged` and `unmerged` are events (`ADR-0001`), so a wrong merge is reversible with
  history intact.

## Rationale

**Accept everything, reconcile after.** The cost of a duplicate incident that gets merged
five minutes later is a small amount of operator work. The cost of a rejected report is
potentially a life. These are not comparable, so the design is asymmetric on purpose.

Separating the two entities also makes something important expressible: **how many
independent people reported this.** Five reports on one incident is corroboration — a
useful severity signal that a merged-into-one model would throw away.

Requiring human confirmation for merges reflects a real limit: proximity and time are weak
evidence in a district where two accidents on the same road within an hour is entirely
plausible. A heuristic confident enough to auto-merge would also be confident enough to
merge two genuinely separate emergencies into one, and hide the second.

## Consequences

### We gain
- INV-01 holds at the intake boundary — nothing is ever rejected.
- A clean board: one open incident per real event.
- Corroboration count as a severity signal.
- Reversible merges, since merging is an event.

### We give up
- A single simple entity. Every consumer must know which one it wants.
- Some immediacy: a newly arrived report may briefly appear as its own incident before an
  operator links it.

### We must therefore also
- Make the merge interface fast and obvious, or operators will not use it and the board
  will fill with duplicates anyway. This is a **critical-path UX task**, not a
  housekeeping screen.
- Define what happens to notifications already sent for an incident that is subsequently
  merged away — the receiving officer must not be left tracking a vanished incident.
- Ensure metrics count incidents, not reports, while retaining report counts as a
  separate signal.
- Handle the reverse case: one report that turns out to describe two separate emergencies
  (a multi-vehicle pileup and a separate fire). Splitting must be possible.

## Alternatives considered

**One entity; deduplicate at intake by rejecting.** Rejected: violates INV-01, and a
rejected reporter does not retry.

**One entity; auto-merge with a confidence threshold.** Rejected: any threshold loose
enough to catch real duplicates will eventually merge two genuine emergencies, hiding one
completely. That failure is silent and severe.

**One entity with a `duplicate_of` pointer.** Considered and close to the chosen design,
but rejected because it makes the duplicate a second-class incident that still occupies
the board and still triggered routing before being marked. The report/incident split
prevents the routing cascade in the first place.

## How we would know this was wrong

- Operators rarely merge anything during the pilot, because true multi-report events are
  rarer than assumed — meaning the split adds complexity for little benefit.
- Merge decisions become a bottleneck under load, with reports queueing for operator
  attention during a mass-casualty event. That would argue for a carefully bounded
  auto-merge for very high-confidence cases only, with easy reversal.
