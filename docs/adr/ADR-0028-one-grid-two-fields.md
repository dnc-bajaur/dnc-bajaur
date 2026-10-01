# ADR-0028 — One grid, two fields: the screen merges and the record does not

**Status:** Accepted · 2026-08-24
**Decided by:** the project owner, answering the question this repository had held open since
2026-08-22. Asked whether `category` and `kind` should become one list of tiles, they answered
*"han merge kar lu"* — and in the same message set the condition that makes it survivable:
*"jis tarha whatsapp ka flow hum nai banaya hai wo wese ka wese hi hoga, es mai koi chnages nhe
hone chaye hain."*
**Answers:** question 1 of [`backlog/five-categories-questions.md`](../../backlog/five-categories-questions.md),
choosing **option (c)** — the option that document recommends against.
**Rests on:** [ADR-0001](./ADR-0001-event-log-as-record.md) — the payload is append-only, so a
field the screen stops asking for is a field no later correction can supply.
**Constrains:** nothing in `domain/`. Not one function changed.

---

## Context

The district described the screen they wanted as eleven tiles in one list: Security, Fire, RTA,
Medical, Flood, Alert, Advisory, Meeting, Information, Another Rescue Emergency, Other.

This software has never had one list. It has two fields, and it has them because they answer
different questions:

* **`category`** — *what it is about*: `fire`, `rta`, `medical`, `flood`, `security`, `other`.
* **`kind`** — *what kind of message this is*: `emergency`, `alert`, `advisory`, `order`,
  `meeting`, `schedule`, `other`.

The district's list uses both at once, which is why
[`backlog/five-categories-questions.md`](../../backlog/five-categories-questions.md) opened with
this exact question on 2026-08-22 and refused to build anything until it was answered. A **security
alert** is genuinely both: an alert, about security. Today an operator fills in both correctly
without thinking about it, because the form asks two questions in two places.

That document set out three answers and recommended against the third — **(c) the operator picks
one of the list by hand** — on the grounds that it adds a question at the moment somebody is
working fastest, and that a wrongly filed item lands in a panel nobody is watching.

Four things read the pair, and none of them is cosmetic:

| Reader | What it decides |
|---|---|
| `responseOptions.listFor` | which 3–5 options the officer is offered on WhatsApp |
| `acknowledgementThanks.thanksKindFor` | which of the district's three closing sentences is sent |
| `events.CARRIES_SLA` | whether there is an acknowledgement clock and an escalation ladder |
| `carrying.laneOf` | which panel it sits in on the dashboard |

## Decision

**The screen merges into one grid. The record keeps both fields.**

`web/src/main.ts` gains a `TILES` table mapping every tile to a `{ category, kind }` pair, and
**every pair in it is one the two old controls already produced.** A tile writes both. The kind
`<select>` is **hidden rather than removed**, written by the tile and dispatched as a `change`, so
`compose.ts`'s kind-specific boxes, the submit button's own words and the invitation row keep
reading the one control they have always read.

Three consequences of the owner's condition follow, and each is a decision in its own right:

**Thirteen tiles, not eleven.** `order` and `schedule` appear on neither the district's list nor
the mock-up. Dropping them would have removed two things this software can do today — a DC-office
instruction that carries an SLA, and a duty roster — with nothing on any screen saying so. Silently
deleting a capability is precisely what *"the WhatsApp flow does not change"* forbids, so they are
tiles twelve and thirteen.

**Six of the thirteen are message kinds, and a handset at a scene is not offered them.** `Alert`,
`Advisory`, `Order`, `Meeting`, `Schedule` and `Information` are revealed by `.all`, set on exactly
the line that already reveals `#whatBlock` to an administrative seat. An officer standing at a road
accident is not choosing between four kinds of message, and thirteen tiles on a handset would push
*Report emergency* down the screen — which is M0-36's cost measured in seconds.

**`rescue` is a seventh category.** *Another Rescue Emergency* is an emergency type, not a message
kind, so it is `{ category: 'rescue', kind: 'emergency' }` rather than a second spelling of
`other`. It is a value this product has never written, and it is safe by design rather than by
luck: both label maps already fall back to the capitalised code for anything unmapped and say so in
their own comments, and `listFor` sends every unknown category to the *other* list — which is where
an unclassified rescue call goes today. Both maps are given the word anyway, so no screen prints a
code.

## What we give up

**Combinations. A flood advisory was two choices and is now one tile.**

This is the whole cost, it is the one the five-categories document named, and it was accepted with
the answer. The grid can say *Flood* or *Advisory*; it cannot say both. An operator sending a flood
warning now files it under `Advisory` — `{ category: 'other', kind: 'advisory' }` — and the
dashboard's flood lane will not show it.

That is a real loss and it is worth stating in the form it will actually be noticed: **on the day
the district asks why a flood warning is not in the flood panel, this is the answer.**

`laneOf` is untouched, so the mapping is one line to widen if they want the subject back.

## Alternatives considered

**(a) The message type wins — the recommendation.** *Security* holds security emergencies only;
every alert and advisory sits under *Alert & Advisory*. Nothing new is asked of the operator and
nothing can be filed wrongly, because the panel reads what they already fill in correctly. It was
recommended and it was not chosen; the district wants the tiles they drew.

**(b) The subject wins.** Workable, but *Alert & Advisory* becomes a leftovers panel that is often
empty while the two above it are full.

**A second row for the subject, shown when a kind tile is chosen.** This keeps both facts and the
district's grid — and it is the third question at the fastest moment that option (c) was warned
about, on four of thirteen tiles. Rejected for now, and it is the obvious repair if the flood-panel
complaint arrives.

**Removing `kind` from the record entirely.** Rejected outright. The field is what four domain
functions read, and the payload is append-only (ADR-0001) — a report written without it can never
be corrected into one that has it.

## How we would know this was wrong

**A flood or security warning that the control room cannot find in its own panel.** The dashboard's
lanes read `category`, and every alert and advisory now carries `other`. If the district reports
that their *Flood* panel is empty on a day they sent flood warnings, this decision is the cause and
the second-row alternative above is the repair.

**`other` swallowing the record.** Today `category` is a real distribution. If a month's export
shows the large majority of rows as `other`, the merge has flattened the district's own filing and
the panels built on it are reading noise.

**An operator using the wrong tile to reach the right list.** If the control room starts choosing
*Security* for security alerts because that is where they want to see them — filing an alert as an
emergency, and starting an escalation ladder under it — then the grid is teaching a workaround and
the two questions have to come back.
