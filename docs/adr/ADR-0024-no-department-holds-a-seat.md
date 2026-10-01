# ADR-0024 — No department holds a seat. The control room does everything.

**Status:** Accepted · 2026-08-22
**Decided by:** the project owner, explicitly and unprompted, in the middle of the ADR-0023
conversation.
**Reverses:** `D-02` in `backlog/for-the-district.md` — *"should a department be able to give its own
people logins? **Yes**, for people in its own department."*
**Amends:** [ADR-0003](./ADR-0003-authority-as-data.md) — the policy table gains `ownerTiers`.
**Answers:** `Q-17`, which had been pinned open in `api/__tests__/lifecycle.test.ts` since M0.
**Completes:** [ADR-0018](./ADR-0018-control-room-only.md), which removed the department's screens
on 2026-08-06 and left the locks behind them open.

---

## Context

The owner, in their own words:

> *"Department ko koi access nahi milne wala hai, un ka koi account nahi banega, software mein
> sirf wahi users hain jo abhi hain ya future mein add karenge … department khud update kare wala
> concept hi khatam kar do … mujhe yeh concept hi nahi chahiye ke department khud kuch kar sake
> app ke andar."*

### This was already half done, and the half that was missing was the dangerous half

**"My department" left the shell on 2026-08-06**, at this same owner's instruction, with the same
reasoning. What went was the **door**. The **lock behind it did not move**:

| Still open on the server, until this ADR | Where |
|---|---|
| A department editing its own roster | `api/roster.ts` `reach` |
| A department **granting a login** to its own people | `api/roster.ts` `reachPerson` |
| A department reporting its own condition and presence | `api/status.ts` `mayReportFor` |
| A department triaging, acknowledging, resolving and **closing** its own incidents | `domain/authority.ts` `defaultRules` |
| A department maintaining its own fleet | `api/resources.ts`, through the shared `reach` |

So *"no department acts"* was true of Bajaur only because **no department had been given an
account**. It was an accident of provisioning, not a rule — and the software would have said yes
the moment one was issued.

### ⚠️ And one of those gates was self-propagating

`reachPerson` let a department seat grant a login to anybody holding a post in its own department.
Each of those could grant more. **A rule enforced by never issuing the first account cannot be
enforced at all once one exists** — which is why this is written down as a decision rather than
left as a convention.

---

## Decision

**No department seat may write anything.** The control room — the DC Office and the AC Headquarter
Bajaur Office, the two administrative offices of ADR-0010 — does all of it.

### `ownerTiers`, and why it is not `overrideTiers`

The policy table gains one field: **`ownerTiers`**, set to `['district']` on all ten rules, with
`ownerDepartmentId` set to `null`.

`overrideTiers: ['district']` already existed and already let a district seat act. **It is the
wrong instrument, and using it would have changed the district's day rather than their
permissions.** An override carries `reasonRequired`, so the control room would have had to type a
justification on **every triage, every acknowledgement, every resolve** — a sentence extracted from
the only people left who can act, for overriding an owner who no longer exists. That is how a
required field becomes a field people paste *"ok"* into, and then it is not there on the day
somebody needed to read one.

Ownership is what they actually have. `ownerDepartmentId` cannot express it: it is parameterised by
the **incident's** responsible department, and the answer here is about the **seat**, whichever
incident it is.

### It also closed a gap that was already there

`appendOnly` refuses a field to anybody but its owner, deliberately — and it returns **before**
`overrideTiers` is consulted. `incident.actions` is `appendOnly` and was owned by the responsible
department, which means **the control room could not log an action on an emergency held by another
department**. That went unnoticed because the incident screen's four buttons are follow-up,
escalate, resolve and close: `log_action` is reachable over the API alone. With the control room as
owner, it simply works.

---

## What a department still is

**Everything except an actor.** ADR-0023 already established the shape:

* it is where officers are filed, and therefore who can be told
* it is who holds an incident (`routed.departmentIds`)
* it is what a group can draw from
* it is in every past record, for ever

⚠️ **What it must not become is unreachable data.** Deleting departments outright — which the owner
asked about — would take the district's whole contact structure with it, and worse: `seat.tier` is
derived by a database trigger where `department_id IS NULL → 'district'`, so removing departments
would make **every seat district-tier** and `evaluateRead` would widen to let everybody read
everything. That exact failure has happened here once before, when the contact loader defaulted all
83 posts to `district` (see `domain/authority.ts`'s header). Departments stay.

---

## Consequences

**75 tests changed**, and every one of them asserted the capability being removed — *"lets the
owning department triage its own incident"*, *"lets a department add its own post and its own
person"*, *"a department officer sees their own roster after signing in fresh"*. They now assert the
refusal, and the control room does the work in each. That count is the honest measure of how much
of this system was built around a department that acts.

**`Q-17` is answered from the other end.** It asked whether the owning department should be able to
emit an `overridden` event rather than triaging again, and was pinned open so that changing it would
be deliberate. No department acts, so the question does not arise. It is pinned again in its new
shape: if a department ever holds a seat, that is where the decision resurfaces.

**`D-02` is reversed.** Its reasoning — that routing every account request through the DC office
does not scale and ends in shared passwords — was sound and is now the district's problem to feel
rather than ours to pre-empt. It is recorded here so nobody re-derives it as a fix.

**What is deferred:** `is_administration` is still derived from the department rather than being an
explicit flag on a contact. Until it is, the two offices are identified by which department they sit
in — which works, and is the last thread tying authority to the department table. ⚠️ **When it moves,
it must never be read out of the designation text** (ADR-0023, §Consequences).
