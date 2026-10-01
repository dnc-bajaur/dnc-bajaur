# ADR-0025 — A utility report has no expiry. The control room closes it.

**Status:** Accepted · 2026-08-23
**Decided by:** the project owner, relaying the district, when told that removing the window
control would freeze Electricity at four hours.
**Reverses:** [M10-03](../../CHANGELOG.md) — the per-service staleness window, shipped 2026-08-22,
which answered the same complaint by making the number editable.
**Amends:** [INV-02](../01-invariants.md#inv-02--stale-data-is-never-rendered-as-current) — scopes
its automatic degradation to presence, and states how a utility satisfies it instead.
**Supersedes in part:** M10-01, which kept a stale row's *note* and went on withholding its
*status*.
**Narrowed by:** [ADR-0037](ADR-0037-the-wall-drops-the-age.md), 2026-09-08 — the district
asked for the age gone from the **Dashboard's** three status panels, was shown the warning below,
and chose it. This ADR's reasoning stands everywhere else; on the wall, the mitigation it names
no longer exists.

---

## Context

The Status screen carried two configuration selects per service that only the two offices could
see. The owner asked for both to go, and gave the reason for the first: departments no longer
exist, so *"kis ko assign hoga?"* — an assign control whose only option is **nobody assigned**.

The second select set `stale_minutes`: how long a report on that service stays believable. It was
flagged that removing it would leave Electricity pinned at the install default of **240 minutes**
with nothing in the product able to change it — a twelve-hour load-shedding schedule reported
against a four-hour window, going stale by construction every day.

The answer came back as a rejection of the whole mechanism, not of the control:

> *"district wale koi time cap nhe dena chah rahe hain, wo chahte hain k hum es ko khud hi
> manually handle karenge, auto reset etc ye nhe hoga — control wale control karenge, close
> karenge."*

### The window was the wrong answer to a real complaint, twice

The complaint has now been answered three times, and the first two both kept the timer:

| | What it did | Why it did not hold |
|---|---|---|
| **M10-01**, 2026-08-22 | Kept the officer's *note* past staleness, withheld the *status* | Saved the sentence, threw away the reading it described. Half a row. |
| **M10-03**, 2026-08-22 | Let an office widen the window per service | Still a number somebody has to guess, per service, before the day it is wrong |
| **This ADR** | No window at all for utilities | The report is a statement, and statements are withdrawn by people |

The mistake underneath both earlier attempts was treating a utility panel as a **sensor reading**.
A sensor that stops answering has failed, and degrading it is right. But nothing in Bajaur is
polling PESCO. A duty officer typed *"12 Hours"* because that is what the schedule is, and that
sentence does not stop being true because a clock passed a threshold nobody in the district chose.

## Decision

**`age()` accepts `staleMinutes: null`, and utilities pass it.** A utility reading is `fresh` from
the moment it is reported until somebody reports something else. There is no timer, no auto-reset
and no automatic close.

**`utilityLabel` loses its stale form.** It used to answer `no report since 08:00` — a sentence
about time that did not contain the status at all. It now names the status, or says
`not reported` when nothing was ever reported. Its `clock` parameter went with the branch.

**Presence is untouched and still passes a real window.** *In the field* and *on leave* are claims
the district **dispatches on**, and `NEEDS_END` already exists because one left open for ever is
the failure mode there. `presenceLabel` still renders `not reported since 08:00`.

**`stale_minutes` stays on the `utility` table.** Presence reads the column, the write endpoints
keep their guards, and a migration to delete a value nothing reads for utilities would be a
migration for tidiness. It is inert for utilities and the code says so where it is passed.

## INV-02 is met, not waived

INV-02 forbids rendering stale data **as current**. It does not require a value to be withdrawn on
a timer — that was one implementation of it, and the only one this project had built.

A utility row now satisfies INV-02 the way the rest of the wall does: **the age travels with the
value and is printed beside it.** `asOf` and `ageMinutes` are on every reading, the panel prints
`PESCO · 20 hours ago` next to the status, and `startAges` keeps that age climbing between polls.
A reader is never told the report is current. They are told exactly how old it is and left to
judge it — which is precisely what the people running the district asked to be allowed to do.

⚠️ **What this gives up, stated plainly.** A service nobody has touched for three days now shows
its last status in full colour with a three-day age beside it, where it used to grey out on its
own. That is the trade the district chose: they would rather read a true old sentence with its
date than a placeholder that appears while the situation is still running. The mitigation is the
age, and the age is not optional — if a future screen renders a utility status without it, that
screen breaks INV-02 and this ADR is the reason why.

🔴 **That future screen arrived, and it is the Dashboard — 2026-09-08.** Read the paragraph above
before writing an age back onto the wall: it is not an oversight, it is the district overruling
this ADR's mitigation with the consequence in front of them. [ADR-0037](ADR-0037-the-wall-drops-the-age.md)
is the record of that conversation, including the middle option they turned down.

## Consequences

- The Status screen's window select is gone, and nothing replaces it. There is no number to set.
- `POST /status/utilities/window` still exists, still validates, still records to the change log
  — and no longer changes what the wall says about a utility. Its tests now assert that.
- A dashboard row for a utility is `fresh` or `never`, never `stale`. `toneFor` therefore keeps
  a utility coloured indefinitely, and the web dashboard's `last said:` prefix — which only
  applies to expiring panels — can no longer fire for one.
- The district gains an obligation it asked for: **a utility that is no longer degraded must be
  set back to Normal by hand.** Nothing will do it for them. That is the meaning of *"control
  wale control karenge, close karenge"*.
