# ADR-0030 — The department table is dropped, and the record it protected is gone

**Status:** Accepted · 2026-08-25
**Decided by:** the district, twice in one conversation, with the second answer reversing the
premise of the first.
**Completes:** [ADR-0029](./ADR-0029-the-department-layer-is-removed.md), which removed the layer
and deliberately left the table standing.
**Amends:** [ADR-0010](./ADR-0010-two-rung-ladder.md) — the ladder now has one rung expressed as
`seat.is_administration`, and the derivation from a department is gone.
**Rests on:** [ADR-0024](./ADR-0024-no-department-holds-a-seat.md).

---

## Context

ADR-0029 took departments off every screen and out of every write path, and kept the **table**,
for one reason stated plainly at the time:

> *Past incidents name their departments. A record that cannot name what it says is a record with
> holes in it.*

That was correct, and it was load-bearing: `routed` and `dispatched` events across Bajaur's whole
history carry `department_id`, and `departmentDirectory` is what turns those into names on the
board, in the daily report and in the CSV the district emails onward.

The district then asked why departments still existed at all, and — told that the only remaining
reason was the old record — answered:

> *"mujhe purana record bilkul nahi chahiye, tum completely remove kar do, beshak record khatam
> ho jaye … jo bhi kaam kiya hai sab testing hai."*

**So the reason expired.** What was left was a table of 79 rows that nothing reads, nothing
writes, and no screen offers.

### The size of it was measured, not assumed

Before anything was decided, the record was counted:

| | |
|---|---|
| Incidents | **93** |
| Events | **813** |
| Age | 11–25 August 2026 — two weeks |
| Incidents naming a department | **74 of 93** |

Two weeks, beginning the day the cloud installation came up. The district's own account is that
all of it is test data, and the dates agree with them.

---

## Decision

**Migration 0039 drops `department`, `seat.department_id` and `sla_target.department_id`**, and
the code stops reading all three.

**Authority reads exactly one column: `seat.is_administration`.** 0038 introduced it and read it
*alongside* the department, because both existed during the transition. That clause is deleted.

⚠️ **It is never derived from the designation text** — ADR-0029 §2's rule, restated because this
is the ADR that leaves it as the only rule. A typo, a rename, or an officer entered as
*"AC HQ (acting)"* would move who may issue a district advisory, silently.

### What the record does instead

Nothing is rewritten. **The record was emptied** — by dropping the schema and rebuilding it, not
by deleting rows, because `incident_event` and `incident_reference` both carry append-only
triggers and refused:

```
incident_reference is assign-once; DELETE is not permitted.
```

⚠️ **That refusal is the invariant working, and it was not worked around.** A rebuild does not
defeat it: the old database is discarded and a new, empty log is created, which is exactly what
`freshDatabase.ts` does before every test file. **Disabling the trigger was refused** — it would
have put a working *"make the district's record mutable"* procedure one environment variable away
from Bajaur.

`department` and `person` stay in `RecipientKind` and in every past payload's shape, on the road
ADR-0018, ADR-0022 and ADR-0023 built: **the type survives so old events parse; nothing writes
one.**

---

## Consequences

### We gain

* **One source for authority.** The pair of readers that could disagree is now a single column.
* **A ladder with one rung**, matching what ADR-0010 said the district actually has.
* **A resource, a utility and a post are named once across the district** — uniqueness moved
  from `(department_id, lower(name))` to the name alone.
* **~150 SQL references and 17 files** stop naming a thing that is not there.

### We give up

* **Two weeks of the district's record**, on their instruction. It exists in
  `/var/backups/dnc-pre-rebuild-*.sql` and nowhere else that anybody will look.
* **Escalating within a department first.** Nothing stood on that rung after ADR-0024.
* **The ability to bring departments back cheaply.** They return as a table to refill, not as a
  history to reconstruct — which was already true of ADR-0029 and is now true of the schema too.

### We must therefore also

* ⚠️ **Keep `preflight:0039` in front of every deployment of this migration.** It asks the two
  questions the migration must never ask at boot, and a third the migration itself creates.
* Accept that **a designation is now unique district-wide**: two offices cannot both have a
  *Duty Officer*. This is a real constraint on the district's own naming and it is visible on the
  screen where a contact is added.

---

## Alternatives considered

**Keep the table, keep the record, stop reading departments.** This is ADR-0029, and it is what
was already shipped. Rejected because the district asked a second time, and because the table's
only remaining justification was a record they had just said to discard.

**Delete the incidents and keep the schema.** Refused *by the database* — see above. The
workaround would have been to disable an append-only trigger, which is the one thing this project
will not own a procedure for.

**Rewrite past events to drop their department ids.** Refused outright: ADR-0001. The log is what
happened. Editing it to make a later decision tidy is the failure the whole architecture exists
to prevent.

---

## How we would know this was wrong

* **The district reorganises into real departments with several officers each.** Bajaur is a flat
  list of ~81 posts and 77 of its 79 departments held exactly one person; if that changes, this
  is a decision to revisit rather than a door welded shut.
* **Somebody needs to read an emergency from before 25 August 2026.** They cannot, and the answer
  is the backup, restored beside production and never over it.
* **A designation collision becomes routine** — two offices genuinely needing the same post name
  and having to invent a distinguishing suffix. That would be the district's structure telling us
  the flat namespace is the wrong shape, and it would be visible immediately rather than in six
  months.
