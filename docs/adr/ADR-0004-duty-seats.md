# ADR-0004 — Route to a duty seat, not to a department

**Status:** Accepted · **amended 2026-08-03**
**Date:** 2026-08-01

> **Amendment.** The four-tier hierarchy this ADR described — station → tehsil → district →
> provincial — no longer exists. **ADR-0010** replaced it with two rungs after the district
> told us how Bajaur is actually organised, and migration 0010 collapsed the column. The rest
> of this record stands unchanged: seats, duty assignments and authority-attaches-to-the-post
> are exactly as decided here, and they are what made the tier change a migration rather than
> a rewrite.
>
> Left in place rather than edited into agreement. The four tiers were a real decision, made
> for stated reasons, and the ADR log is the same kind of record as the event log — you
> correct it by appending, not by making the past look like it always agreed (ADR-0001).
**Reversal cost:** High — identity and permission model

## Context

The root idea requires that an emergency be "routed to the responsible department" and
"acknowledged within SLA". Both phrases hide a problem.

**"Notify the Health Department" is not actionable at 03:00.** A department is not a
recipient. Someone specific must receive the alert, and that someone changes by shift, by
day, and by posting.

There is a second, sharper problem specific to government service in Pakistan: **officers
transfer frequently.** A permission model attached to individuals breaks on every posting
order — the new DPO cannot acknowledge anything until IT creates their account and
assigns roles, and the previous DPO retains access to district emergency data from their
new posting until someone remembers to revoke it.

## Decision

Model organisational **seats** as first-class entities, distinct from the people who
occupy them.

- `Seat` — an organisational post (DC Bajaur, DPO Bajaur, Rescue 1122 Station In-Charge,
  Health District Duty Officer). Belongs to a department and a tier.
  *(Amended: the tiers are now `department` and `district`, and a seat's tier is **derived
  from its office** by a database trigger rather than chosen — see ADR-0010 and migration
  0010. The four-value ladder below was superseded before anything used more than two of it.)*
- `DutyAssignment` — which person holds which seat, over which time range. Answers "who do
  I notify right now."
- **Authority attaches to the seat, never to the person.**
- Every event records both the actor and **the seat they held at that moment**, so a later
  transfer does not rewrite history.
- Escalation is a walk up the seat hierarchy, not a hardcoded list of phone numbers.

**Handover is a first-class, auditable action.** The outgoing holder initiates it; the
system lists open incidents and pending obligations attached to the seat; the incoming
holder explicitly accepts; the handover is logged with both parties. Authority transfers
at acceptance, not at the posting order date.

## Rationale

Seats survive transfers; people do not. Modelling the durable thing means:

- A posting order becomes a duty assignment change, not an IT ticket.
- Revocation is automatic — when someone stops holding a seat, they stop having its
  authority, with no cleanup step to forget.
- Notification targets are always current, because the roster is the routing table.
- Escalation chains are expressed once, structurally, rather than duplicated as contact
  lists that go stale.
- Audit history stays truthful: "the DPO acknowledged at 14:22" remains accurate and also
  names who that was.

The handover step exists because the dangerous moment in any duty transfer is the set of
open obligations nobody has explicitly picked up. Forcing acceptance makes the gap visible
rather than silent.

## Consequences

### We gain
- Routing and escalation that survive personnel changes without maintenance.
- Automatic access revocation on transfer.
- INV-06 attribution that remains meaningful years later.
- A natural escalation hierarchy for `ADR-0005`.
  *(Amended: there is no provincial ceiling. The top of the ladder is the district
  administration, and an emergency that reaches it unacknowledged is surfaced as* needs a
  human, urgently *rather than climbing to a rung that does not exist — Q-10, ADR-0010.)*

### We give up
- Simplicity. Three entities (person, seat, assignment) where most systems have one user
  table with a role column.
- Immediate self-service. Someone must maintain the duty roster, and a stale roster
  degrades routing.

### We must therefore also
- Treat **roster freshness as an operational risk** and surface it: a seat with no current
  holder, or an expired assignment, is a visible alarm — not a silent routing failure.
- Provide a fallback when no one holds a required seat: escalate immediately to the tier
  above rather than dropping the notification (INV-01, INV-03).
- Make roster maintenance genuinely low-friction, or it will not happen. This is a UX
  requirement, not an afterthought.
- Confirm the real seat structure per department during domain research — the seats listed
  here are **assumptions** (see `06-open-questions.md` Q-01).

## Alternatives considered

**Users with department + role columns.** Rejected: breaks on every transfer, leaks access
to departed officers, and cannot express "whoever is on duty now."

**Notify the whole department; whoever is free responds.** Rejected: diffusion of
responsibility is exactly what SLA acknowledgement exists to prevent. If everyone is
notified, no one is accountable, and the acknowledgement metric becomes meaningless.

**Groups or distribution lists per department.** Rejected as a half-measure: it solves
addressing but not authority, not shift awareness, and not attribution.

## How we would know this was wrong

- The duty roster is chronically stale during the pilot despite low-friction tooling —
  meaning departments will not maintain it, and routing must fall back to department-wide
  notification with a different accountability mechanism.
- Seat structure turns out to vary so much between departments that the abstraction
  requires per-department special-casing, which would indicate the model is too rigid.
