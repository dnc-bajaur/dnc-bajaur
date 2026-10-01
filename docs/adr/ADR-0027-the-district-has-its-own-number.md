# ADR-0027 — The district has its own number, and it is not the record's

**Status:** Accepted · 2026-08-24
**Decided by:** the project owner, who read the incident detail screen, highlighted the identity
line and asked what it was for — then named the shape they wanted: *"agar aur simplify ho skta hai
tou aur bhi simplify kr du, jese k dnc-bajaur 1 and so on … es ka faeda ye hoga k aik qesam ka
counter bhi mil jaega 1 sai."*
**Rests on:** [ADR-0002](./ADR-0002-offline-first.md) — the uuid is generated on the handset before
any network attempt, and that is exactly why it cannot become the district's number.
**Constrains:** nothing in `domain/`. The number is not in the fold and not in the log.

---

## Context

The line above the buttons on the incident detail screen read:

```
Incident 297e3fba-accf-4298-808a-c3c4d01d3337 · happened 8/24/2026, 6:58:39 PM
```

Thirty-six characters of hexadecimal, on the one screen in the product whose job is to be quoted.
Bajaur's control room rings people about emergencies all night — that is the product — and the only
identity this software had ever offered them was one they cannot pronounce, cannot write on a slip
and cannot ask an officer to repeat back.

The uuid is not the mistake. It is load-bearing and it stays: it is generated on the handset
*before* any network attempt, which is what makes an offline retry a no-op instead of a duplicate
(ADR-0002, INV-08), and it is what every URL, every fold and the outbox are built on. What was
wrong was that it was the **only** identity, offered to a human.

## Decision

**Every incident also gets a number the district counts from 1: `DNC-BAJAUR-1`, `DNC-BAJAUR-2`.**

It is a **receipt number, not a second primary key.** Nothing in the domain reads it. It is
assigned by the primary (ADR-0019) *after* the events commit, it lives in one table nothing else
joins to, and the uuid is unchanged everywhere it was already used.

Three properties, and each is here because losing it makes the number worse than none:

**It is assigned once and never moves.** `UPDATE` and `DELETE` are refused by a trigger on
`incident_reference`, the same way they are on `incident_event` — in the database, not in a code
review. A number printed on a report submitted upward must still point at the same night a year
later.

**It is gapless.** A Postgres sequence was the obvious mechanism and it burns a value on every
rolled-back transaction, so the highest number would slowly stop being the number of incidents.
The district's stated reason for wanting this at all was that it doubles as a count, so
`MAX(seq) + n` under a transaction-scoped advisory lock is what it is worth paying — one lock on a
table this district writes to a few dozen times a month.

**It is ordered by `recorded_at`, not `occurred_at`.** This looks wrong beside migration 0019,
which indexed occurrence precisely so that a report captured offline in March and delivered in
August is filed under March. A counter cannot do that: numbering by occurrence would require
inserting that report *between* two numbers already given out, which an append-only counter cannot
do. So the number means **"the Nth thing this district recorded"** — which is what a receipt number
has always meant, and is honest about what it is.

**It is not an event.** The number is not something anybody did, and the fold could not produce it:
two servers folding the same events must not invent two different numbers. It travels *beside* the
folded state — `BoardRow.reference`, a top-level field on the detail response — never inside it.

**Assignment is a sweep, not an insert.** `assignReferences` numbers everything unnumbered, in
arrival order, whether it arrived a second ago or in March. That one shape gives three things: the
existing month of Bajaur's record numbers itself on the first boot with no backfill script; a failed
assignment is repaired by the next report or the next restart rather than leaving one incident
permanently unnumbered; and it is idempotent, so calling it on every append costs a query that
normally finds nothing.

## Consequences

**The record outranks the counter, and the ordering says so.** The sweep runs *after* the append
transaction commits and inside a `catch` that swallows and logs. An emergency that is safely stored
must never be reported as failed because a counter could not be incremented (INV-01).

**`null` is therefore a real state, and every surface must survive it.** An incident can exist for a
moment — or until the next restart — with no number. The detail screen and the printed report say
**`not yet numbered`** in words; the board row draws nothing; the export leaves the cell empty. A
blank identity line would read as a screen that failed to load (ADR-0005).

**The uuid is not hidden, it is demoted.** It is the URL, it is `Record id` on the printed report,
and it is the second column of the export. What is gone is it being the first thing a human is
offered.

**Searching for the number finds the incident, and ignores the date window.** Everything else in
search is a question about *when*; a number is a question about *which*. Answering "nothing found"
because an operator's period happened to start after it would be the filing-cabinet-without-a-
drawer-label failure that screen exists to end. Scoping is untouched — the row still goes through
`projectIncidents`, so a seat with no authority over it gets nothing back and never learns the
number belongs to anything (INV-05).

**A bare `42` is accepted, and the referenced incident is *added* to the text results rather than
replacing them.** A district where `42` is also a house number in a description keeps both
readings.

**The prefix is a constant, not configuration**, on the same terms as `DISTRICT_TIMEZONE`. A second
district gets its own deployment, its own database and its own counter starting at 1 — which is the
correct answer anyway, because two districts sharing one counter would interleave their numbers and
neither could say how many emergencies it had had.

**It is not padded.** `DNC-BAJAUR-0001` sorts prettily and lies about the size of the thing being
counted: it says the district planned for ten thousand and has had one.

**What this does not do: it does not reach WhatsApp.** Putting the number into an outbound message
would let an officer quote it back, which is the obvious next step and the most valuable one. It is
deliberately not in this change, because the message body is a Meta-approved template and that
belongs to the district (see `backlog/for-the-owner.md`).
