# ADR-0001 — The event log is the record; state is a projection

**Status:** Accepted
**Date:** 2026-08-01
**Reversal cost:** Very high — a total rewrite once real incident data exists

## Context

The root requirement demands a complete audit trail for every emergency: who reported it,
who routed it, who acknowledged it, who overrode what and why, through to closure. It also
demands that central administration can override department data without duplicating it,
and that the system works offline and reconciles later.

The conventional approach is mutable tables (`incidents`, `incident_status`) with an
`audit_log` table written alongside every change.

That approach fails here for a specific, predictable reason: **an audit log written
alongside the data will eventually disagree with the data.** A migration, a bulk fix, a
missed hook in one code path, a transaction that commits the row but not the log entry —
and the audit trail is quietly wrong. In an ordinary CRUD application that is an
inconvenience. In a system where the audit trail may be the evidence for why an emergency
response took two hours, it is a product failure.

## Decision

Every meaningful act on an incident is recorded as an **immutable, append-only event**.
The incident's current state is computed by folding its events. Read models are
projections — caches that can be dropped and rebuilt from the log at any time.

There is no mutable status column on `Incident`. Corrections are new events, never edits.

## Rationale

An audit log that *is* the data cannot disagree with the data.

Beyond correctness, one mechanism solves five problems that would otherwise each need
their own:

- **Audit** — structural, not a parallel write that can be missed.
- **Offline replay** — a queued client event is the same shape as a server event.
- **Central override** — an override is just an event that wins in the projection, so the
  department's original value survives (see `ADR-0003`).
- **Conflict resolution** — concurrent writes are ordered events, resolved by rule, with
  the loser visible rather than silently lost.
- **Post-incident reconstruction** — "what did the DC see at 14:20?" is a fold up to a
  timestamp, not an archaeology project.

## Consequences

### We gain
- An audit trail that cannot drift (INV-06).
- Deterministic reconstruction of any past state.
- A natural sync unit for offline clients (`ADR-0002`).
- Override and conflict semantics that fall out of the model rather than being bolted on.

### We give up
- Simple reads. Every view needs a projection.
- Familiarity. Most developers reach for CRUD by default and will need to be held to this.
- Easy ad-hoc SQL against "current state" — that now means querying a projection.

### We must therefore also
- Treat projection rebuildability as a **tested property**, not an assumption. A milestone
  gate drops every projection and rebuilds from the log, asserting identical output.
- Version event payloads from the start, since events are immutable and will outlive
  several schema generations.
- Enforce, in review and in tests, that no code path mutates incident state directly.

## Alternatives considered

**CRUD tables plus an audit log.** Rejected: the drift problem above, and it makes offline
reconciliation and override provenance genuinely hard rather than incidental.

**Full CQRS with a separate write store and eventual consistency.** Rejected as
overengineering for this scale. We take event sourcing for the incident aggregate only,
inside one Postgres, with synchronous projection updates. Hundreds of incidents a day does
not justify eventual consistency and the operational surface it brings (`ADR-0007`).

**Temporal tables / system-versioned rows.** Rejected: gives history but not *intent*. It
records that severity changed from HIGH to CRITICAL, not that the control room overrode it
because a second reporter confirmed casualties. Intent is what the audit trail is for.

## How we would know this was wrong

- Projection rebuild time grows past a few minutes for a single incident's lifetime — the
  fold is too expensive and the aggregate boundary is wrong.
- Developers routinely need "just the current state" in contexts where no projection fits,
  suggesting the read model is under-designed.
- Event types proliferate past roughly thirty for the incident aggregate — a sign we are
  modelling UI actions rather than domain facts.
