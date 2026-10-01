# ADR-0007 — Boring, single-node, operable at 02:00

**Status:** Accepted
**Date:** 2026-08-01
**Reversal cost:** Medium — replaceable per layer

## Context

The operational reality of this system is a district government IT setup, not an SRE
rotation. There will be no on-call team, no platform engineer, and quite possibly no
dedicated infrastructure person at all after handover.

**The system's real availability ceiling is set by whoever can fix it at 02:00 with the
DC on the phone** — not by its design diagram. An architecture with excellent theoretical
availability that nobody present can debug has worse *actual* availability than a simpler
one that a competent generalist understands completely.

The most common failure mode for government platforms is not a technical one. It is
abandonment: the original developers leave, nobody can maintain what they built, and
within eighteen months the system is running unpatched on someone's goodwill, or gone.

## Decision

The selection criterion for every technology choice is **the 02:00 test**:

> Can one competent person, possibly the district's own IT staff, understand this well
> enough to fix it at two in the morning?

Concretely: one Postgres, one backend deployable, one frontend, one background worker.
Full table in `05-stack.md`. Notably:

- **PostgreSQL** doing four jobs — relational data, event store, PostGIS location, and
  `LISTEN/NOTIFY` realtime.
- **One typed monolith** with clear internal module boundaries. Not microservices.
- **SSE over an outbox table** for realtime, not websockets and not a broker.
- **A Postgres-backed job queue** in the same process for SLA timers and notification
  retries. No Redis.
- **PWA client**, so an urgent fix does not wait on app store review.
- **In-country hosting** with a documented on-premise fallback.

### The dependency rule

Every new dependency must answer, before it is added:

1. Who restarts this when it fails?
2. How do they know it failed?

If either answer is "nobody" or "they don't", it is rejected regardless of technical
merit. The answers are recorded in the ADR that introduces it.

## Rationale

Every component removed is a component that cannot fail at 02:00, cannot need a version
upgrade nobody understands, and cannot become the reason the system is abandoned.

Postgres earns its place four times over. A message broker earns its place zero times at
this scale — hundreds of incidents a day does not require Kafka, and the operational
surface it adds is real. The same reasoning rejects Redis, a service mesh, and a separate
search cluster.

The monolith is not a compromise. For a system with one team, one deployment target, and
strongly coupled domain logic, it is the correct choice — one log stream to read, one
process to restart, one deploy to roll back.

## Consequences

### We gain
- One log stream, one process, one deploy, one rollback.
- Debuggable with `psql` and a log tail — tools any competent person already has.
- A realistic chance of surviving handover, which is the actual long-term risk.

### We give up
- Independent scaling of components. Accepted: the load profile does not require it.
- Best-in-class realtime fan-out. SSE over an outbox is adequate for a district-scale
  audience.
- Some resume appeal. Explicitly not a criterion.

### We must therefore also
- Maintain **strict internal module boundaries** in the monolith, so that if a component
  ever genuinely needs extraction, it can be extracted. A monolith is not permission for
  a mess.
- Deliver operational requirements in M0, not later: structured logs with correlation ids,
  a health endpoint a monitor can page on, automated backup, and **a restore drill
  actually performed by someone who is not the original developer.** A documented restore
  procedure that has never been executed is not a backup strategy.
- Confirm this stack with the eventual maintainer before M0 (`06-open-questions.md`
  Q-03). Choosing for operability is meaningless without knowing who operates it.

## Alternatives considered

**Microservices per department.** Rejected: department boundaries are not service
boundaries here — they share one incident log by design (`ADR-0001`). This would force
distributed transactions to satisfy the single-source-of-truth requirement, which is the
worst of both worlds.

**Managed cloud-native (serverless, managed queues, managed search).** Rejected on two
grounds: data sovereignty for citizen emergency records, and survivability if
international connectivity degrades — which is a live concern here, not hypothetical.

**Kafka or RabbitMQ for the event log.** Rejected: Postgres tables give durability,
ordering, queryability, and transactional consistency with the rest of the data, at a
fraction of the operational cost. Adding a broker would also split the event log from the
projections it feeds, reintroducing the drift `ADR-0001` exists to prevent.

## How we would know this was wrong

- Sustained write volume makes single-Postgres event append a genuine bottleneck. At that
  point partition or extract — but measure first, and note that this district's volume is
  unlikely to approach it.
- The realtime fan-out over SSE cannot serve the connected client count during a major
  incident, which would justify a dedicated push service.
- The maintaining organisation identified in Q-03 has strong existing capability in a
  different stack. Their operational familiarity would outweigh these choices — the
  principle survives even if the specific technologies change.
