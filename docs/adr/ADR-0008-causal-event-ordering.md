# ADR-0008 — Events carry a causal sequence, not just timestamps

**Status:** Accepted
**Date:** 2026-08-01
**Reversal cost:** Medium — schema column and comparator, but only before real data exists

## Context

`ADR-0001` makes the event log the record and derives state by folding it. That only works
if the fold order is right. The original comparator was:

```
occurred_at, then recorded_at, then event_id
```

An integration test caught why this is wrong, and it is worth stating precisely because
the failure is subtle and was intermittent.

A client submitting several events at once — which is the **normal** case, not an edge
case, since an offline device syncs a batch — produces events sharing a single
millisecond. So `occurred_at` ties.

Postgres `now()` is **transaction time**, constant for every row in one `INSERT`. So
`recorded_at` ties too.

Ordering then fell entirely to `event_id`, a random UUID. Four events stored in the order
`acknowledged, overridden, reported, triaged`. The fold applied `triaged` **after**
`overridden`, and because `triaged` legitimately updates severity, the district's override
was silently discarded.

The comparator was deterministic — the same input always produced the same output, and a
shuffle test confirmed it. It was also wrong. **Determinism was never the hard part.**

## Decision

Every event carries `clientSeq`: a monotonic per-incident counter assigned by the client
that created it. The stored row additionally carries `seq`, a database identity column
recording server arrival order.

The comparator becomes:

```
occurred_at, then client_seq, then recorded_at, then event_id
```

And the sync cursor becomes `seq`, not a timestamp.

## Rationale

`clientSeq` preserves causality where it actually matters: within one device's batch, the
order the operator did things in. That is knowledge only the client has, and no server-side
timestamp can recover it.

`seq` does two jobs. It breaks ties between genuinely independent clients — a case with no
true causal order, where any stable answer is honest. And it is the correct sync cursor: a
timestamp cursor silently skips every event sharing a `recorded_at`, so a client resuming
mid-batch would lose the remainder of it permanently and invisibly. That is the same root
cause as the ordering bug, wearing a different hat, and it would have been far harder to
find in production.

## Consequences

### We gain
- A fold order that reflects what actually happened, not what the UUID generator decided.
- A sync cursor that cannot skip events.
- A regression test that reproduces the original failure exactly.

### We give up
- A little client complexity: the outbox must assign and persist a per-incident counter,
  and keep it monotonic across restarts.

### We must therefore also
- Make `clientSeq` durable on the client, alongside the outbox itself. A counter reset to
  zero after a crash would reintroduce ties.
- Keep the SQL `ORDER BY` and the TypeScript comparator identical. They are now tested
  against each other directly, because a silent divergence would be very hard to spot.
- Accept that events from two different devices about one incident have no true ordering.
  `seq` gives a stable answer, not a correct one — there is no correct one.

## Alternatives considered

**Higher-resolution timestamps.** Rejected: microseconds narrow the window but do not
close it, and it would not have fixed the `recorded_at` tie at all, since that is
transaction-time by design rather than by precision.

**Hybrid logical clocks / vector clocks.** Genuinely correct for distributed causality, and
rejected as disproportionate. This system has one server and clients that do not
communicate with each other. `ADR-0007`'s operability constraint applies: a vector clock is
a thing nobody in the district can debug at 02:00.

**Server-assigned sequence only, no `clientSeq`.** Rejected: it orders by arrival, which
during an outage is meaningless. A batch synced after two hours would be ordered by
whatever the network delivered first.

## How we would know this was wrong

- Clients turn out to reorder or drop `clientSeq` in practice, making it untrustworthy —
  at which point arrival order plus explicit causal references would be the fallback.
- Two-device concurrent editing of one incident becomes common enough that "stable but
  arbitrary" is no longer acceptable, which would argue for real causal tracking.

## Postscript

This is the value of building the spine early, and it arrived in week one. The bug was
invisible in the pure domain tests, which supplied distinct timestamps, and only appeared
against a real database with real transaction semantics. A design document would never
have caught it.
