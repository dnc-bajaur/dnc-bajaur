# ADR-0020 — The district's day ends at midnight, on every surface

**Status:** Accepted · 2026-08-13 · **AMENDED 2026-08-19 by ADR-0021 — the day is the
Dashboard's, not the board's. Read the amendment before this record.**
**Decided by:** the project owner, on the district's behalf, asked three times and answered three
times.
**Amends:** ADR-0013 (§1, the dashboard shows aggregates) and the board's seven-day selection.
**Changes the behaviour of:** `jobs/escalation.ts`.

> **This record was rewritten once, the same day.** Its first version justified the board's reset
> by pointing at the escalation job — *"the screen forgets, the system does not"*. The owner then
> bounded escalation to the day as well, which **removes that justification entirely**. Appending a
> line to a decision whose argument no longer holds would leave the strongest sentence in this
> repository defending something that is no longer true. It is rewritten instead.

---

## ⚠️ AMENDED 2026-08-19 — the day is the DASHBOARD's, and this record put it on the wrong screen

**Amended by [ADR-0021](./ADR-0021-the-record-absorbs-search-and-reports.md). Read this section
before acting on anything below it.**

**The reasoning in this record is sound and survives. What was wrong is which screen it was
applied to.** One district day *is* the unit; the district *did* ask for a daily reset; escalation
*is* bounded to that day, unchanged. But the reset was given to the **board**, and the owner's
intent — stated from the beginning of the project and re-stated three times on 2026-08-19 — was
that it belongs to the **Dashboard**, which is the screen the district is actually run from.

**The Dashboard was never touched by this decision at all.** It went on folding a rolling seven
days while the tile above the count said `today` and the board beneath it showed one day — three
surfaces describing three periods. It surfaced as an **empty board sitting beside a Dashboard
reporting 37 issued and 13 with nobody chosen**, and the owner asked, correctly, which of the two
to believe.

| | This record decided | Now |
|---|---|---|
| Resets at the district's midnight | the board | **the Dashboard** |
| Keeps everything, every day | — | **the Record** (what this record calls the board) |
| Escalation bounded to one day (§4b) | yes | **unchanged** |
| Every surface names its own period | yes | **unchanged, and it now applies to a view that is not a day** |

**Two obligations this record named are met differently, and one is met better.**

- *"A date control on the board"* — still true of the Record, **and the Record no longer opens on
  a day at all**: it opens on the whole record, newest first, whatever day it started. This
  record's own fear — *"the district has traded a cluttered board for an unreachable one"* — was
  sharper than it knew, because §4b then removed the escalation that would have chased those
  cases. A view reachable only by somebody who already knows it is there is not reachable.

  > **Refined 2026-09-06 (the owner).** That view was first built as *what is still open, any
  > day*, and dropping the finished rows put a stale still-open case at the head of the list
  > while the newest thing that happened — resolved by lunchtime — was off-screen. It now folds
  > **open and closed alike**, ordered newest-entered first, so however the Record is reached the
  > newest record is on top. The day views are untouched: they stay live-work only, and the
  > Dashboard→Record path still lands on the filtered today-slice so a counter and its rows agree.
- *"Today's report opens with what is still outstanding from before"* — **superseded by something
  louder.** That safety net was put in a report with **no named reader**, which this record admits
  in its own *"the safety net is a human one"* section. It is now a **fenced strip on the
  Dashboard itself**, under `FROM EARLIER DAYS`, carrying both what is still open and what was
  resolved today from an earlier day.

**§5's refusal to change the activity panel is reversed**, and the old reasoning expired rather
than being wrong: it answered *what has been happening* on a screen that was itself a rolling
seven days. Once every figure above it resets at midnight, a rolling window puts last night's
hours on a screen whose counters have already forgotten them.

**What is NOT amended:** §4b in full, the accepted failure mode, and the statement that this
breaks no invariant.

---

## The decision

**One district day is the unit, everywhere.**

- **The board** shows today and resets at the district's own midnight.
- **Escalation** runs for today's incidents only. At midnight it stops — for everything, including
  emergencies nobody has acknowledged.
- **Everything earlier** is reached by date through the daily report.
- **Nothing is ever deleted.** The event log is untouched by any of this.

Both boundaries come from `startOfNamedDistrictDay`, **the same function, not two definitions.**

## Why

The district asked for it:

> *"Rozana reset hona chahiye… kisi bhi soorat mein data loss nahi hona chahiye, but regular har
> din data us din ke liye reset hona zaruri hai."*
>
> *"Escalations bhi sirf ek din ke liye rahenge. Ek din ke baad koi bhi escalation pending cheezon
> ke liye nahi jana chahiye."*

A control room that opens its screen and sees a week of accumulated rows cannot tell what is
**today's district** and what is residue. The count at the top is the number the DC reads first,
and a seven-day count is not a number anybody acts on before breakfast. **The district will not
accept a board that never empties**, and a board people learn to discount is worse than one that
shows less.

The same argument carries to escalation. An escalation ladder still firing on Thursday about
Monday's unacknowledged notice is noise arriving during Thursday's emergencies, and noise on that
channel is paid for by the messages that matter.

## What it replaces

- `buildBoard` selected `options.days ?? 7` and dropped closed statuses — *"the last seven days of
  anything not yet closed"*. Items left it by being closed, **never by the clock.**
- `jobs/escalation.ts` scanned `LOOKBACK_DAYS = 7` on **rolling 24-hour arithmetic**
  (`now() - make_interval(days => 7)`), which is not the district's day and never was. It also had
  a quiet property: **an escalation's own event kept its incident inside the window**, so a chase
  could sustain itself.

## What is given up, stated plainly

**An emergency reported at 23:50 and unacknowledged at 00:01 is no longer pursued by any software.**
It leaves the board, escalation stops, no further notification is sent. It exists — completely and
permanently — in the event log and in that day's report, and nowhere a person will pass by
accidentally.

**This does not break any of the eight invariants**, and an earlier draft of this record wrongly
implied that it broke INV-01. It does not. INV-01 is *"once a reporter presses submit, the record
exists somewhere durable"*, and every implication under it concerns **intake** — the outbox,
validation, duplicates. The record still exists, durably, forever. **What is given up was never an
invariant**: it was a seven-day setting in one job, and it is now a one-day setting in the same job.

Saying so accurately matters more than saying so dramatically. **A decision defended with an
overstatement is a decision nobody can weigh.**

## The safety net is a human one, and the owner accepted it as such

Asked directly who reads the previous day's report and when:

> *"Koi bhi parh sakte hain, aur record ke liye bhi hai."*

So: **any user may open any past day, and no named person is assigned to review yesterday's report
each morning.** That is recorded as it was given. Many district offices work exactly this way and
it is a legitimate operating model — **the net is the morning habit of the control room, not a
timer.** It is written here so that if an emergency is ever missed across a midnight, nobody has to
reconstruct which choice produced it.

## What must be built for this to be true rather than hoped

**Obligations, not enhancements. The reset must not ship without them.**

- **A date control on the board**, defaulting to today, reaching any past day. Without it the
  district has traded a cluttered board for an unreachable one, which is the worse of the two.
- **Today's report opens with what is still outstanding from before** — *"3 emergencies from
  earlier days were never acknowledged"*, with their dates. In the **report**, not on the board, so
  the reset is honoured in full. This is the single thing that turns *"anyone may read it"* into
  *"somebody will see it"*, and it is the closest this design comes to a safety net.
- ~~**An escalation that fires today is today's activity**, whatever day its incident began.~~
  **Satisfied structurally, and that is a better outcome than the feature would have been.**
  `jobs/escalation.ts` and `buildBoard` now select by **the same rule** — *arrived that day, or
  happened that day* — so an incident that can escalate today is on today's board **by
  construction**. There is nothing to build and nothing that can drift. Written down because the
  obligation was real: without it, a daily reset becomes a way to escape an obligation **by
  outlasting it**.
- **The last escalation of the day writes a closing event**, so the record says *the chase ended
  here, unacknowledged*, rather than simply going quiet. A log that stops without saying it stopped
  cannot be read afterwards.
- **An emergency that happened yesterday and arrived today is on today's board.** This is not on
  the district's list and it is not optional: a fire reported at 23:40 from a village with no
  signal and synced at 06:10 would otherwise be filed under a day nobody is looking at, **while it
  is still burning**. It is yesterday's fact and today's work, and the two surfaces answer
  different questions — so it appears on today's board *and* in yesterday's report, and neither is
  lying. Anything else would break the offline story (ADR-0002) at its most expensive point.

## Consequences

- **ADR-0013 §1 stands.** The board still shows aggregates and nothing on it is a thing to open.
  Only its selection changes.
- **The "today" counters become honest.** They have reset at the district midnight since Phase 1
  while the list beneath them carried seven days — **the counter and the list have been describing
  different periods all along**, and nobody had noticed. This removes the discrepancy as a side
  effect, not as its purpose.
- **Escalation stops using rolling-24h arithmetic**, which removes the self-sustaining window as
  well as shortening it.
- **Search is unaffected** — it always had its own selection and shares only `projectIncidents`.
- **Two surfaces will now routinely disagree about what is "current"**, and correctly: one is a day
  and one is a record. Every screen must therefore show **which date it is showing**, always, not
  only when that date is not today.

## How we would know this was wrong

- **An emergency is missed across a midnight.** That is the accepted failure mode, and it is the
  signal to change back — **not** a reason to add a warning banner and keep the design.
- **The "still outstanding from before" line grows and stays grown.** This whole decision rests on
  the assumption that the district closes its work within the day. That line is the measurement of
  the assumption, and it is the reason it must exist.
- **Nobody opens a past day for a month.** Then the record is a filing cabinet, not a safety net,
  and the honest response is to give the morning review a named owner rather than to widen the
  board again.
