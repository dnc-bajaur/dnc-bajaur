# Data Model

Deliberately small. A large model at this stage is a sign the domain has not been
understood. Everything here either appears in an emergency's lifecycle or explains who was
allowed to touch it.

This is a **specification sketch**, not a schema. Migration-ready DDL is produced in M0
against the decisions recorded here.

> **Currency, stated honestly (2026-08-13).** This document was written before M0 and last
> revised on 3 August. The database now holds **thirty tables across twenty-eight migrations**;
> the sketch below names about half of them. That is not automatically wrong — a sketch is meant
> to be smaller than a schema — but the parts that had drifted into being *false* have been
> corrected: the event catalog was missing four types that exist and are written, and the entity
> table did not mention the lifecycle tokens, availability, or General communications at all.
>
> **`app/db/migrations/` is the authority.** When this document and a migration disagree, the
> migration is right and this document is a bug.

---

## Entities

| Entity | Role in the system | Notes |
|---|---|---|
| `Report` | A single claim that something happened. Cheap, never rejected, never deleted. | Channel (web / SMS / call / radio / walk-in), reporter contact, raw text, media, location capture, `occurred_at`. |
| `Incident` | The authoritative thing in the world. One or more reports link to it. | **Has no mutable status column.** Status is folded from its events. |
| `IncidentEvent` | Append-only. The entire history and the entire audit trail. | Typed — see the event catalog below. |
| `Seat` | An organisational post that holds authority — not a person. | Belongs to a department. Its tier is **derived from that department** — `district` for the two administrative offices, `department` for everyone else (ADR-0010, migration 0010). It was a four-value ladder until the district explained that there are two rungs. |
| `DutyAssignment` | Which person holds which seat, over which time range. | Makes "who do I notify right now" answerable; makes handover a logged event. |
| `Person` | A human with credentials. | Holds seats over time; has no authority of their own. |
| `Department` | A registry row, not a code module. | Module config, freshness expectation, routing categories, escalation chain. |
| `AuthorityRule` | Who owns a field, who may override it, whether a reason is required. | Data, administrator-editable, covered by tests. See `04-authority-model.md`. |
| `NotificationAttempt` | One try, on one channel, to one endpoint, with a delivery state. | Never collapsed into a boolean (INV-03). |
| `ContactEndpoint` | A reachable address for a seat or person, per channel. | Phone, WhatsApp, SMS, email, push token. Verified state tracked. |
| `Place` | Gazetteer of tehsils, union councils, villages and landmarks with coordinates. | The unglamorous asset that makes location usable. |
| `Evidence` | Media or documents attached to a report, response action, or closure. | Stored by reference; upload may lag the event it belongs to. |
| `Projection` | Derived read models — district board, department board, metrics. | Rebuildable from the event log at any time. **Never edited directly.** |

### Added since the sketch, and load-bearing

These are not refinements of the above. Each one carries a decision, and each one is reachable
from a screen the district uses.

| Entity | Role | Notes |
|---|---|---|
| `AckToken` | A single-use link, minted for one person and one seat, that lets an officer act **without signing in**. | Carries a `stage` — `acknowledge` \| `respond` \| `resolve` \| `availability` (migrations 0026, 0027). **No `issued` value**: nothing is ever moved back to the beginning. Spent on POST, only *peeked* on GET, so a link-preview crawler cannot resolve an emergency. |
| `PresenceReport` | Where an officer says they are. | Five answers — `present`, `office`, `field`, `absent`, `leave`. Attaches to the **person** as well as the post (migration 0027): *"the AAC is on leave"* is a fact about an officer, not about a chair. Three of the five must state when they end. |
| `RecipientGroup` | A named set of recipients — "tell this whole department". | With `RecipientGroupMember` (migration 0024). Collapses to the department row when everyone in it is selected, so the picker never shows forty ticks where one belongs. |
| `FileToken` | A single-use link to an attachment, openable by an officer with no account. | Migration 0025. An attachment **travels as a link, not as a file** — Meta will only put a document on a template approved to carry one, and Bajaur's is not. |
| `RoutingSignal` | The configuration that decides which department an emergency reaches. | Set by the two administrative offices, never inferred (Q-18). Anything unmatched surfaces as **unassigned** for a human. |
| `SlaTarget` | The acknowledgement deadline, per department and per severity. | The district's own rule, editable in the console (Q-06). `unknown` is settable — not a level (ADR-0009), but where the urgency of an unassessed report now lives. |
| `DashboardLayout` | Which panels the control-room screen shows, and where. | ADR-0015: layouts are data. Migration 0022. |
| `CapabilityState` | Which optional screens this installation offers. | **One row for the whole installation** — worth knowing, because it means a test that enables a capability changes what every other test sees. |
| `DistrictAlert` | An advisory issued to the district, distinct from an incident. | Appears in the activity window and in the daily report as *issued that day* — never as *currently live*, which would make yesterday's report change every time somebody read it. |
| `WhatsAppMessage` | One outbound message and what Meta said about it. | The delivery record behind INV-03. |
| `ConfigEvent` | Append-only log of every configuration change, with who made it. | Guarded by the same kind of trigger as `incident_event`: `TRUNCATE` is refused at the database. |
| `BackupRun` | One nightly backup, its verification, and whether the off-site copy succeeded. | See `08-runbook.md`. |
| `NewsFetch` | The last successful read of the Pakistan headline feed, and its age. | Migration 0028. Not the district's information, and every part of the panel's design says so. |

**Notice what is not here:** no separate dashboard tables, no per-department incident
tables, no denormalised copies for the central view. The central board and the Rescue 1122
board are two projections of one event log, filtered differently and authorised
differently.

That is the "one source of truth" requirement expressed **structurally** rather than as a
rule people have to remember.

---

## Event catalog

Every event carries, without exception:

```
event_id          uuid, client-generated (idempotency key)
incident_id       uuid
type              enum
occurred_at       timestamptz  — when it happened, per the actor
recorded_at       timestamptz  — when the server first accepted it
actor_person_id   uuid, nullable (null for system events)
actor_seat_id     uuid, nullable — the seat held at the time
source_channel    enum — web / mobile / sms / call / radio / system
payload           jsonb — type-specific
```

| Event | Meaning | Payload notes |
|---|---|---|
| `reported` | A report was linked to this incident | report_id, initial category, location capture |
| `triaged` | Severity and category set or revised | severity, category, reason if revised |
| `routed` | Responsible department(s) assigned | department_ids, rule_id or `manual`, reason |
| `dispatched` | The message was sent to a chosen set of recipients | recipient refs (seat / person / group) |
| `contact_opened` | An operator opened a call or a WhatsApp thread from inside the incident | channel, target — **an attempt by a human, recorded as one** |
| `notified` | A notification was **attempted** — not sent, not received | attempt_id, channel, seat, reason |
| `notification_delivered` | An attempt actually reached a human | attempt_id, seat, channel |
| `notification_failed` | An attempt could not be made or did not arrive | attempt_id, seat, channel, **failure** |
| `acknowledged` | A duty seat accepted responsibility | seat_id, elapsed vs SLA |
| `assigned` | Team, vehicle, or resource committed | resource refs |
| `released` | A committed resource was freed again | resource refs |
| `action_logged` | A response action was recorded | free text, evidence refs |
| `escalated` | Moved up the seat hierarchy | from_seat, to_seat, trigger: `sla_breach` / `manual` / `severity` |
| `reassigned` | Responsible department changed | from, to, actor, **reason required** |
| `overridden` | A field was overridden by authority | field, old value, new value, **reason required** |
| `merged` | This incident absorbed another | absorbed_incident_id, reason |
| `unmerged` | A merge was reversed | restored_incident_id, reason |
| `resolved` | Response complete | outcome, evidence refs |
| `closed` | Administratively closed | closure notes, evidence refs |
| `reopened` | Closure reversed | **reason required** |
| `corrected` | Something already sent was wrong | **reason required**, replacement optional |
| `late_arrival_flagged` | Gap between occurred and recorded exceeded threshold | gap duration |

### `corrected` deserves its own paragraph

The district asked for undo and delete. Neither is possible and neither would be honest:
**nothing can unsend a delivered WhatsApp message.** `corrected` is what exists instead. It

- **requires a reason** and makes the replacement **optional** — *"ignore this, we will confirm
  later"* is an honest answer, and demanding a replacement produces invented ones;
- **does not change the status.** A meeting notice with the wrong date is not resolved, it is
  wrong;
- may be emitted **after closure**, because that is when mistakes are noticed, and **more than
  once** — the first says *ignore this*, the second says what is true, and both stay in the log;
- is authorised through `incident.correction`, not `incident.actions`. The latter is
  `appendOnly`, which the authority table refuses to anybody but the owner, and the message that
  went out wrong was usually sent **by the control room** on somebody else's behalf.

Nothing is struck through, on screen or on paper. A crossed-out line reads as *this did not
happen*, and it did.

### Rules

- Events are **append-only**. There is no update or delete. A mistake is corrected by a
  new event, not by editing the old one.
- Ordering within an incident is by `occurred_at`, tie-broken by `recorded_at` then
  `event_id`. Replay is deterministic.
- `event_id` is generated on the client so that a retry after an unclear network failure
  is a no-op rather than a duplicate (INV-08).
- An event whose `actor_seat_id` is set records the seat **as held at that moment** — a
  later transfer does not rewrite history.

---

## Kind: not everything the district sends is an emergency

A single `MessageKind` on the incident, with seven values:

```
emergency  alert  advisory  order      <- CARRIES_SLA
meeting    schedule  other             <- General
```

The split is `CARRIES_SLA`. The four above it have an acknowledgement clock and an escalation
ladder; the three below it have neither. `isGeneral(kind)` is the one place that is decided, and
the server resolves it before the board row is sent, so **the renderer carries no second copy of
which kinds are emergencies**.

This is not presentation. A meeting notice that rendered with a severity word and the sentence
*"unacknowledged"* is, at a glance on a control-room screen, **an emergency nobody has
answered** — which is what M9-11 fixed. A General communication now shows what it *is* where a
severity would be, and says *sent · no answer needed* or *answered*.

---

## Stages: a view, and nothing stored

Officers were shown seven statuses and asked to reason about them. They are now shown four:

```
Issued -> Acknowledged -> Responded -> Resolved
```

**There is no stage column, no stage event, and no migration.** `domain/stages.ts` maps the seven
statuses the fold already produces onto the four words, and both the board row and the detail
heading take the word from the server so the mapping exists **once**. A test asserts that every
status the fold can produce has a stage — a new status must not silently become invisible.

Two things this deliberately does not do:

- **`issued` is never offered as a destination.** Nothing moves back to the beginning, and the
  database constraint refuses the value too. A constraint that permits what the code forbids
  invites whoever reads only one of them.
- **`responding` is still a status nothing assigns.** The respond link writes an **action in the
  officer's name**, and the fold moves itself. A stage claimable without an act would be a button
  that says work is happening.

---

## Projections

Read models, rebuilt by folding events. Each carries `as_of` and its coverage.

| Projection | Serves | Freshness sensitivity |
|---|---|---|
| `incident_current` | Any view of a single incident | Rebuilt on every event |
| `district_board` | Central command view — all active incidents | Must carry coverage per department (INV-02, INV-05) |
| `department_board` | One department's workspace | Scoped by authority |
| `sla_watch` | Incidents approaching or past acknowledgement deadline | Drives the server-side timer job |
| `department_health` | Heartbeat and freshness per department | Drives the "no contact" state (`ADR-0005`) |
| `metrics_daily` | Response times, escalation rates, occurred-to-recorded gaps | Batch; not on the critical path |
| `activity_window` | The control room's last 24 hours, twenty at a time | **Holds no state at all** — no cursor, no seen flag, no queue. A function of the events and the clock, recomputed every render, so a restart cannot lose it |
| `daily_report` | One named district day, as HTML to read and print or CSV to file | Built from the log on request; `GET /reports/daily` |

**Rebuildability is a tested property**, not an assumption. A milestone gate includes
dropping every projection and rebuilding from the log with identical results.

---

## Location

Layered capture — any one layer is sufficient (see `00-thesis.md`, "no reliable street
addresses"):

1. GPS pin, when the device can provide one
2. Cascading tehsil → union council → village, from `Place`
3. Landmark search against `Place`
4. Free text

Stored as: an optional point geometry, an optional `place_id`, and the free text. The
system records **which layers were captured**, so a downstream consumer knows whether a
pin is a GPS fix or an operator's best guess at a landmark.

---

## Retention and privacy

- Reporter contact details are restricted-read and never appear in exports without
  explicit authority.
- Incident history is retained indefinitely — it is the district's record.
- Media has a separate, shorter retention policy to be decided (see
  `06-open-questions.md`).
- Personal data handling must be confirmed against Pakistani data protection
  requirements — **currently an open question, marked blocking for anything touching
  citizen PII at scale.**
