# ADR-0031 — The word "department" is removed from the product's vocabulary

**Status:** Accepted · 2026-09-01
**Decided by:** the owner, after a live bug — adding a contact in the directory on
`dnc.example.com` returned `{"error":"no such department"}`, on an installation where the
department concept was supposedly already gone.
**Completes:** [ADR-0029](./ADR-0029-the-department-layer-is-removed.md) and
[ADR-0030](./ADR-0030-the-department-table-is-dropped.md), which removed the layer and dropped
the table but left the *word* threaded through the spine — a seat tier called `department`, a
`RecipientKind` value, a board facet, config-event subjects, and router segments that answered
*"no such department"* for anything that was not a UUID.
**Amends:** [ADR-0010](./ADR-0010-two-rung-ladder.md) — the lower rung of the ladder is a
`post`, not a `department`.

---

## Context

ADR-0029 removed the department layer from every screen and write path. ADR-0030 dropped the
table. Both were careful to keep types and log vocabulary so the append-only past stayed
readable — the road ADR-0018 and ADR-0022 had already proven.

But this installation's record was rebuilt on 25 August (ADR-0030's own premise): **there is no
historical department data anywhere.** Zero `routed` or `dispatched` payloads name a department,
zero `config_event` rows carry a department subject, and the 239 live `seat.tier` rows all read
the string `'department'` only because a trigger derives it and nobody renamed the value.

So the caution that kept the word alive no longer applies here, and the word was still doing
harm:

* The redesigned admin console posts a new contact to `POST /roster/people` — a route that does
  not exist. The router reads `people` as a department id, fails its UUID shape check, and
  answers **`no such department`**. The same class of failure sits on `/roster/:dept/posts`,
  `/fleet/:dept`, `/contacts/department/:id` and the `/admin/layout` scope segment.
* `seat.tier` carries `'department'`, `TIER_ORDER` and `evaluateRead` compare against it, and
  every reader of the word has to know it means *"an ordinary post"*.
* `RecipientKind` still offers `'department'`, so `domain/recipients.ts`, `groupStore.ts`,
  `dispatch.ts`, `notifications.ts`, `report.ts`, `learning.ts` and the board's facet panel all
  branch on a value the live database can never produce.

The owner asked for it removed at the root — *"har jaga sai es ka concept and rule or code agar
baake hai tou hata du, department ki jaga software ka ju standerd hai wo hr jaga use hona chaye
hai"* — and acknowledged this is more than one session's work.

## Decision

**The word "department" stops being part of how the software talks about itself.** Where the
software already has a standard for the thing the word used to name, that standard is used:

| Where "department" appeared | Replaced by |
|---|---|
| `seat.tier` value / `Tier` type / `TIER_ORDER` | `'post'` — a contact is a post (ADR-0029) |
| the trigger function `seat_tier_from_department()` | `seat_tier()`, deriving from `is_administration` |
| `RecipientKind` value `'department'` | removed — a target is a `post` or a `person` |
| the board's `department` facet | removed |
| `config_event` subject `'department'` | removed from the known-subjects CHECK |
| routes `/roster/:dept`, `/fleet/:dept`, `/contacts/department/:id`, `/admin/layout/:scope` | flat routes — `POST /roster/posts`, `POST /roster/people`, `POST /fleet/units` |
| params `departmentId` on `readRoster`, `addPost`, `addRosterPerson`, `readFleet`, `addResource` | dropped |
| `DISTRICT_SCOPE` nil-uuid path hack in `web/src/roster.ts` | gone with the scoped routes |

The `Seat.departmentId` / `AuthorityRule.ownerDepartmentId` fields, always `null` since ADR-0024,
and the `evaluateRead` middle branch that reads them, are removed in the same sweep.

### It lands in phases, and the working tree is deployable at each one

1. **The tier vocabulary** (this commit). `seat.tier` value `'department'` → `'post'`,
   `authority.ts`, the escalation-ladder fallbacks, `rosterStore` / `seed` seat inserts,
   `ops/integrity.ts`'s trigger-mirror check, and migration **0042**
   (`0042_drop_department_tier.sql`) — rename the function, `UPDATE seat SET tier = 'post'`,
   swap the `seat_tier_check` CHECK to `tier IN ('post', 'district')`. Behaviour-neutral:
   `evaluateRead`/`evaluateWrite` only ever compare against `'district'`.
2. **`RecipientKind`** (done). `'department'` is off `domain/events.ts`. The `KINDS` arrays in
   `api/dispatch.ts`, `api/groups.ts` and `db/groupStore.ts` are `['post', 'person']`; the
   `case 'department'` in `domain/notifications.ts`'s dispatch switch, the post-absorbed-by-its-
   department branches in `domain/recipients.ts`, the `toldDepartments` loop in `api/lifecycle.ts`,
   the department-target synthesis in `api/performance.ts`, the legacy department rows in
   `api/contacts.ts`, and `domain/learning.ts`'s dead `hasSomethingToProposeIt` are all gone.
   `domain/report.ts`'s `nameOfTarget` keeps a `default` branch that still names a
   department-kinded target from some other installation's log by its id. Migration **0043**
   (`0043_group_member_no_department.sql`) deletes any legacy `kind = 'department'` group member
   (0 on this installation) and narrows the `recipient_group_member.kind` CHECK to
   `('post', 'person')` — no guard, O-40. Behaviour-neutral: the picker has offered contacts
   only since ADR-0023 and no live selection or dispatch names a department.
3. **The roster routes and params** (done). `server.ts` gains flat `POST /roster/posts` and
   `POST /roster/people` and drops the `/roster/:dept` block; `readRoster`, `addPost` and
   `addRosterPerson` lose their `departmentId` parameter (it had been `void`ed since ADR-0030).
   `web/src/roster.ts` and `web/src/admin.ts` call `POST /roster/posts`, `POST /roster/people`
   and `GET /roster` — the console's bare `POST /roster/people` was what the router read as a
   department id and answered `{"error":"no such department"}` on the *add contact* button.
   `CACHE` → `dnc-shell-v191`. ⚠️ **Deferred out of this phase, no live impact:** the
   `/fleet/:dept` routes and `resources.ts`'s `departmentId` (the fleet is already
   non-functional post-ADR-0030 — `identity.departmentId` is always null — and has no frontend
   caller; flattening it is a design question, not a route rename), `/contacts/department/:id`
   + `departmentContacts` (coupled to the Phase 4 deletion of `web/src/contact.ts`), and
   `/admin/layout/:scope` (zero callers, `void`ed `scope`). These move to phase 4.
4. **The last remnants** (done). `ConfigSubject` loses `'department'` — **no migration**: the
   `config_event_subject_known` CHECK is append-only and validating a narrowed `ADD CONSTRAINT`
   against an install that holds old `department` rows refuses at boot (migration 0039 spells
   this out), so the log keeps its vocabulary and nothing writes a new `department` row anyway.
   `Seat.departmentId` and `AuthorityRule.ownerDepartmentId` are off their interfaces —
   `null` for every seat since ADR-0024 — and `evaluateRead`'s middle branch (a seat reading a
   routed incident it was in the department of) goes with them: since migration 0039 the
   `responsibleDepartmentIds.length === 0` window is the only branch that fires, so a placed
   incident is now readable by a district seat as `override` and by nobody else. The board's
   `department` facet **and** the `department` sort are removed — the folded list was empty on
   every row, and the board does not narrow or order by a word this product no longer uses.
   `web/src/contact.ts` and the per-department "Reach them" buttons on the incident screen are
   deleted, along with `/contacts/department/:id` and `departmentContacts` — the last place the
   software could answer `{"error":"no such department"}`. `/fleet/:dept` flattens to
   `POST /fleet/units` (`readFleet` / `addResource` lose `departmentId`, `reach` is gone —
   `resources.ts` asks `mayEditRoster` directly); `/admin/layout/:scope` flattens to
   `/admin/layout` (`layoutForConsole` / `setLayout` lose `scope`). `summary.ts`'s report
   `scope` string is `'district' | 'post'`; `ops/integrity.ts`'s `examplesAre` field is gone;
   the client `Identity.tier` type is `'post' | 'district' | null`.

   ⚠️ **Two `department` remnants are deliberately kept.** The board's internal `boardFilter.kind`
   tag `'department'` — the dashboard "Open by officer" drill-through — is persisted in M11-17
   saved-view URLs, so renaming it breaks links people have already copied out of the address
   bar; it reads `row.dataset['told']`, not a department, and the label shown is an officer or
   panel name. And `responsibleDepartmentIds` / `route` / `reassign` / `incident.responsibleDepartment`
   stay — they are the incident-assignment domain concept tied to append-only event history
   (ADR-0001), the same reasoning that kept `report.ts`'s `nameOfTarget` default branch and
   `RecipientKind`'s cross-install readers.

Each phase is its own commit, `npm run check` green before any deploy, deployed in a quiet
window (this class of migration caused a 34-minute Bajaur outage once — CLAUDE.md §5).

## Consequences

### What this buys

* The directory's *add a contact* button works, and `no such department` is not a sentence the
  software can produce.
* One vocabulary. A reader of `seat.tier` or `RecipientKind` is not decoding a word that means
  something other than it says.
* The `evaluateRead` middle branch and two always-null fields go — dead weight since ADR-0024.

### What it costs

* **A migration per phase.** 0042 is `UPDATE seat` on 239 rows plus a CHECK swap — trivial, no
  guard, no `RAISE` (O-40's lesson).
* **~60 test files** carry `tier: 'department'`, `{ kind: 'department' }` or seat inserts with
  the old value. They are reworked phase by phase, not in one sweep.
* **Reversal is expensive in code, free in data.** The ids and every past event are untouched;
  bringing the word back is re-widening types, not reconstructing a history.

## Alternatives considered

**Keep the word, alias it.** A `Tier` type whose lower value is spelled `post` but whose runtime
string stays `'department'` for compatibility. Rejected: the compatibility it buys is with a
history this installation does not have, and it leaves the decoding cost in place for ever.

**Fix only the failing route.** Add `POST /roster/people` and stop. Rejected by the owner
explicitly — *fix at the root*, not the symptom.

**Rewrite past events.** There are none to rewrite here, and ADR-0001 forbids it regardless.

## How we would know this was wrong

* **Bajaur reorganises into real multi-officer departments.** Then the flat post namespace is the
  wrong shape and this is a decision to revisit — the same trigger ADR-0030 names.
* **A second installation with real department history adopts this build.** The phased migrations
  would need a data-preservation story that this one, with an empty record, did not.
