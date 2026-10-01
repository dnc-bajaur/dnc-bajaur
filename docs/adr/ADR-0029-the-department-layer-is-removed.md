# ADR-0029 — The department layer is removed. A contact is a name, a number and a post.

**Status:** Accepted · 2026-08-25
**Decided by:** the district, answering all three questions left open in
`backlog/contacts-without-departments.md` §10, and adding a fourth requirement of their own.
**Completes:** [ADR-0023](./ADR-0023-the-directory-is-a-contact-list.md), which took departments off
the **picker** and left the **table** standing.
**Amends:** [ADR-0010](./ADR-0010-two-rung-ladder.md) — a seat's tier is no longer derived from a
department, because there are no departments to derive it from.
**Rests on:** [ADR-0004](./ADR-0004-authority-attaches-to-the-post.md) and
[ADR-0024](./ADR-0024-no-department-holds-a-seat.md).
**Reverses:** ADR-0023's *"a vacant post stays in the list, marked"*.

---

## Context

The district was asked three questions and answered all three, then said in one sentence what they
had actually wanted the whole time:

> *"Mujhe simple phone ki tarha contact add karne ka option chahiye, jis mein main Name, phone,
> post/designation de sakta hoon … iske ilawa main groups bhi bana sakta hoon. So agar iske liye
> departments ko completely wash karna pare to bhi kar do. Control room khud apne hisaab se
> contacts add kar denge. Ye jo abhi 79 hain … ye bilkul bhi zaroori nahi, isko delete karne se
> district ko koi nuqsan nahi hoga. Haan agar software ko nuqsan hai to batao hum kaise tackle
> karenge."*

That last sentence is the reason this is an ADR and not a commit message.

### The audit it asked for

The department layer is load-bearing in exactly **one** place, and dead in every other:

| What depends on `department` | Live? | Why |
|---|---|---|
| `is_administration` → `identity.isAdministration` | 🔴 **Live and load-bearing** | Every write authority in the system rests on this one boolean |
| `evaluateRead` cross-department scoping | ⚪ Dead | ADR-0024: no department holds an account. Nothing exercises it |
| `seat.tier` trigger | 🟡 Derived | Derives from `is_administration`, which is moving, not disappearing |
| `nextSeatUp` ladder rung | 🟡 One rung of two | The lower rung has no accounts on it (ADR-0024) |
| `sla_target.department_id` | 🟡 Keyed by it | 79 near-identical rows expressing one district-wide rule |
| Recipient picker rows | ⚪ Already gone | ADR-0023 |
| *Open by department*, *Response times per department* | 🟡 Drawn | 79–80 rows, unreadable across a room |
| The event log's `department_ids` | 🟢 Permanent | Append-only. Never rewritten (ADR-0001) |

**So the honest answer to the district was: one checkbox, and the rest is subtraction.**

---

## Decision

### 1. A contact is three fields

```
Name          Sher Ali Khan
Designation   AC HQ Bajaur
Phone         0300 0000558
```

Add one, remove one, edit one. No department to file it under. **Groups are the only way to tell
many people** — the district's own argument and the correct one: a department can hold only its own
people, a group holds whoever the control room says.

### 2. `is_administration` moves from the department to the contact — as a checkbox

This is the whole of what survives, and it survives because **permission must never be read out of
typed words.** If the software decided authority by matching the designation, then a typo, a rename,
or somebody entered as *"AC HQ (acting)"* would silently gain or lose the right to issue an
advisory, and no screen would show it.

One checkbox, ticked on three or four contacts by the two offices, once. `identity.isAdministration`
reads it from there instead of from a joined table. Nothing above it changes.

### 3. Vacant posts are removed — and `vacant` is **not** `no_number`

The district said to drop them, and this reverses ADR-0023's *"a vacant post stays in the list,
marked"*. It is safe to reverse, for a reason worth stating rather than assuming:

ADR-0023 kept vacancies because **a vacant post must never swallow an obligation** — ticked,
recorded as told, nobody told. **Deleting the row removes that failure mode entirely**, because a
row that cannot be ticked cannot swallow anything. What is genuinely lost is smaller, and is only
this: the district stops being told which of its seats are empty. That is their call and they have
made it.

🔴 **But the two words are not the same, and the district's own data proves it.** Of Bajaur's 81
rows, **38 have no number** and only **34 are vacant**. The other four hold a **named officer whose
number was never recorded** — and they are these:

| Post | Holder |
|---|---|
| Rescue 1122 — District Emergency Officer | Noor Rahman Khan |
| Civil Defence — CDO | Shahid |
| DHQ Hospital — Associate Hospital Director | Dr. Saleem |
| Traffic Police — SP Traffic | Fazal Ud Din |

Implementing *"remove the vacant ones"* as *"remove the ones with no number"* would take **Rescue
1122's District Emergency Officer off the district's contact list**. `domain/recipients.ts` already
separates `vacant` from `no_number`; this ADR binds the deletion to `vacant` — **no holder** — and
the four named-without-a-number contacts stay, listed for the district to fill in.

**81 rows become 47.**

### 4. Irrigation and WSSC become ordinary contacts

The only two departments holding more than one person. Each of their people becomes a contact
carrying their own designation — `XEN Irrigation Division` already says Irrigation.

### 5. Both department panels become per officer

*Open by department* and *Response times per department* are drawn per officer. 79 near-singleton
rows were never a measurement of anything.

### 6. The record is not touched

`department_ids` on every past `routed` event stays, for ever, and the type keeps the field. This is
the fourth time this project has walked this exact road:

| | Removed | Kept |
|---|---|---|
| ADR-0018 | the in-app inbox | `NotifyChannel: 'web'` in the type; nothing writes it |
| ADR-0022 | routing signals | `ruleId: 'auto'`, `signalIds` in the type; nothing writes them |
| ADR-0023 | department and person as things to **pick** | both kinds in the type and the log |
| **ADR-0029** | **the department table as somewhere a contact is filed** | **the column, the ids, and every past incident's reading of them** |

---

## Consequences

### We gain

* The contact list the district asked for, and nothing standing between them and it.
* **A whole layer of the permission model stops being reachable.** Read scoping, seat tiers, the
  lower rung of the ladder, per-department report scoping — code nobody can reach is code that
  cannot be wrong.
* 47 rows in place of 81, every one of them a person somebody can actually ring.

### We give up

* **Knowing which seats in Bajaur are empty.** Chosen deliberately (§3). If the district misses it,
  it comes back as a marker on a contact, not as a table.
* **Per-department response times.** Never a real measurement at one person per department.
* **Growing into real departments without a migration.** The ids stay in the log, so this is a
  decision to revisit, not a door welded shut.

### We must therefore also

* Ask the district for the four missing numbers (§3) — filed in `backlog/for-the-district.md`.
* Ensure the `is_administration` checkbox is ticked **before** the department table stops being
  read, never after. A window in which nobody is the administration is a window in which nobody can
  issue an advisory.

---

## Alternatives considered

**Derive administration from the designation text.** Rejected in §2 — permission read from typed
words fails silently and invisibly.

**Keep the department table and hide it from the screens.** That is exactly what ADR-0023 did, and
it is why the district had to ask a second time. The rows were still there, still filed into, still
producing 79-row panels.

**Keep vacancies as a marker** — the standing recommendation in the plan document. The district
chose otherwise, and §3 is why that choice costs less than the recommendation assumed.

---

## How we would know this was wrong

* **The control room names a department in free text on an incident**, because they wanted to say
  who is responsible and the designation would not carry it. That is the layer being genuinely
  missed.
* **A group is rebuilt by hand that is simply a department**, three or more times. If somebody keeps
  reassembling `Irrigation`, the layer was carrying something after all.
* **An advisory cannot be issued because no contact carries the administration tick.** That is §2
  implemented wrongly, and it is a production outage — which is why it is called out under *we must
  therefore also* rather than left to be discovered.
