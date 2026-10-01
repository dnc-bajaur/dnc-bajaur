# ADR-0002 — Offline is the substrate, not a later phase

**Status:** Accepted
**Date:** 2026-08-01
**Reversal cost:** Very high — retrofitting offline is a rewrite

## Context

Bajaur is a hard-area district in Khyber Pakhtunkhwa. Connectivity there is not merely
imperfect:

- Routine poor coverage across rural union councils.
- Congested links during any large event — exactly when the system matters most.
- **Deliberate mobile and internet shutdowns during security operations**, lasting hours
  or days.

The original engineering handbook places offline resilience in Phase 16, after
implementation and external integrations. That ordering is the single most consequential
mistake available on this project.

A system built assuming connectivity treats a failed write as an error to display. A
system built assuming intermittency treats a failed write as the normal case and a
successful one as the fast path. These produce fundamentally different code at every write
site, every state transition, and every screen — and you cannot convert the first into the
second by adding a sync layer later.

## Decision

Offline operation is the substrate from the first commit.

- Every client write is an **event with a client-generated UUID**, persisted to a durable
  local outbox **before** any network attempt.
- The UUID is the idempotency key. A retry after an ambiguous failure is a no-op.
- Every event carries `occurred_at` (device time, when it happened) and receives
  `recorded_at` (server time, when accepted).
- Queued items display an explicit **pending** state — never a checkmark. A user must
  never believe an emergency reached the control room when it is still on the handset.
- **Airplane mode is a required test environment**, present from M0.

## Rationale

The UUID-first, outbox-first pattern costs almost nothing on day one. Adding it on day two
hundred means revisiting every mutation, every optimistic UI decision, every error path,
and every test — while a district depends on the system.

It also composes with `ADR-0001` at no extra cost: an event queued on a client is
structurally identical to an event created on the server. There is one write path, not two.

## Consequences

### We gain
- INV-01 (an emergency is never lost) becomes achievable rather than aspirational.
- Sync, retry, and deduplication are one mechanism, not three.
- The L2 rung of the connectivity ladder works by construction.

### We give up
- Simple timestamps. Two time fields with different uses is a permanent source of subtle
  bugs and must be documented and tested carefully.
- Naive optimistic UI. "Saved" now means "durably queued", and the interface must say
  which.
- Some server-side validation immediacy — a client cannot know at capture time whether a
  reference is still valid.

### We must therefore also
- Define timestamp semantics explicitly and enforce them:
  **measurement uses `occurred_at`; escalation firing uses `recorded_at` plus a grace
  window.** See `02-connectivity-ladder.md`.
- Surface the gap between the two as a first-class field — it is the district's real
  connectivity picture, measured rather than assumed.
- Guarantee bounded, deduplicated notification output on reconnect (INV-08). A two-hour
  outage must not page forty people about resolved incidents.
- Design the L3 (SMS/voice) and L4 (paper log and catch-up ingestion) rungs as real
  deliverables, not contingency prose.

## Alternatives considered

**Online-only with a friendly error.** Rejected outright. During a shutdown this system
would be useless at precisely the moment a district most needs coordination.

**Offline for reads, online-only for writes.** Rejected: reading a stale dashboard during
an emergency has little value. Capturing the emergency is the whole point.

**A generic sync framework or local-first database.** Deferred, not rejected. The
domain-specific rules — authority-based conflict resolution, notification suppression on
replay, late-arrival flagging — are not things a general framework handles well. Revisit
if the hand-rolled outbox becomes a maintenance burden.

## How we would know this was wrong

- Measured `occurred_at`/`recorded_at` gaps are near zero across a full pilot in every
  union council, indicating connectivity is better than assumed and the complexity is not
  earning its keep. (Unlikely, and cheap insurance if true.)
- The outbox becomes a recurring source of user-visible bugs that a mature local-first
  library would have solved — at which point we adopt one rather than abandon the
  principle.
