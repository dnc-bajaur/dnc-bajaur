# ADR-0021 — The Dashboard is the day; the Record is everything else

**Status:** Accepted · 2026-08-19
**Decided by:** the project owner, across one long correction session, answered point by point.
**Amends:** [ADR-0020](./ADR-0020-the-board-is-a-day.md) — the daily reset moves from the board
to the Dashboard, and §5's refusal to rewindow the activity panel is reversed.
**Changes the behaviour of:** `api/dashboard.ts`, `domain/activity.ts`, the board route, and the
navigation.

---

## The decision

**Three screens, three jobs, and no two of them answer the same question.**

| Screen | Period | Job |
|---|---|---|
| **Dashboard** | **Today**, resets at the district's own midnight | What the district is run from. Every figure clickable |
| **Record** (was Board) | Everything, any day, up to the record's own ceiling | Where anything is looked up or acted on. Absorbs **Search** and **Reports** |
| **Report** | — | Filing a new report. Unchanged |

`Search` ceases to be a tab. The navigation becomes:

`Dashboard · Report · Record · Administration · Status · How to use`

**An incident belongs to the day it started.** Work done today on an older case does not return
it to today's Dashboard.

**Escalation stays bounded to one district day** — ADR-0020 §4b, unchanged.

---

## Why this record exists at all

ADR-0020 was right about the unit and wrong about the screen. It is worth being exact about that,
because the reasoning it contains is good and a reader who dismisses the whole record loses it.

**The owner asked for a daily reset on the Dashboard from the beginning of the project.** ADR-0020
put it on the **board** and never touched the Dashboard, which went on folding a rolling seven
days — while the tile above the count said `today`, and the board beneath it showed one day.

**Three surfaces, three periods, and nothing on any of them said so.** It surfaced the way these
things always surface: an **empty board sitting beside a Dashboard reporting 37 issued and 13 with
nobody chosen**, and the owner asking which of the two to believe.

**This is the fifth time in this project that a document outlived the decision it was written
under**, and the first where the document was an ADR.

---

## What this costs, stated before anything else

**An incident that started before today and is still open gets no Dashboard counter and no
escalation.** The software will not chase it and will not count it.

That is two decisions compounding — the strict day rule here, and ADR-0020 §4b — and the owner was
asked about each separately and chose both.

**So the safety net is not optional and it is not a report.** It is:

1. **A fenced strip on the Dashboard**, under `FROM EARLIER DAYS`, carrying **what is still open
   with the age of the oldest**, and **what was resolved today from an earlier day**.
2. **The Record opening on everything still open**, whatever day it started — not on today.

**Either one alone is insufficient.** The strip is a count; the Record is where the rows are. And
ADR-0020's own safety net — a block in a report — was put somewhere with **no named reader**,
which that record admits in its own words. This one is on the screen the DC reads first.

### The half nobody would have asked for

`resolvedToday` exists because the strict day rule has a second, quieter cost: **the control room
can resolve five old cases this afternoon and read `Resolved 0` on the wall that evening**, because
every one of them belongs to an earlier day. True, and useless. A district that cannot see its own
work on the screen it is judged by will stop believing the screen.

---

## Why the Record absorbs Search rather than sitting beside it

**They were never two screens.** `api/search.ts` has shared `projectIncidents` with the board since
search was built and differs **only in which incidents it hands it** — the fold, the authority
check and the row renderer are one implementation already. So this joins two **selections** behind
one screen; it does not merge two implementations, and there is nothing here that can drift.

**One screen answers one question at a time.** A search **replaces** the day's table, and the
summary strip, the banner and the reports block go with it — every figure on those describes the
**day**, and leaving them above search results puts a count over rows it did not count.

---

## What is given up, and what is not

**Given up:** the ability to read the district's current state off the Record. That is the
Dashboard's job now, and two screens answering it is how they come to disagree.

**Given up:** the activity panel's rolling twenty-four hours (ADR-0020 §5). At 00:30 that panel is
nearly empty where it used to carry the evening. **The old reasoning expired rather than being
wrong** — it answered *what has been happening* on a screen that was itself a rolling seven days.

**Not given up:** nothing is ever deleted; escalation's bound; every surface naming its own period;
the wall carrying no reporter, number or place; scoping decided server-side.

---

## The rule that survives ADR-0020 and applies harder here

**Every screen says which period it is showing, always.**

ADR-0020 wrote that for a board that was always a day. The Record's landing view is the one thing
in this product that is **not** a day — so its date control is **emptied** rather than left holding
whatever day was last looked at, and the screen says *"everything still open, any day — not one
day"* in words. A control reading `19 Aug` above a list spanning two years is the screen naming a
day it is not showing, which is the failure that rule exists to refuse.

**Asking the board for a day and for what is still open at once is a 400, never a guess.**

---

## How we would know this was wrong

- **The carry-over strip grows and stays grown.** This design rests on the district closing its
  work within the day. That strip is the measurement of the assumption, and the reason it must
  exist rather than being a nicety.
- **An emergency is missed across a midnight anyway.** Then the strip is not loud enough, and the
  honest response is to give it more weight — **not** to widen the Dashboard back to a week, which
  is the state this record was written to leave.
- **Nobody opens the Record.** Then the reset has produced a filing cabinet after all, and the
  answer is the one ADR-0020 already named: give the morning review a named owner.
