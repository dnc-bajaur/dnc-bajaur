# ADR-0013 — One application, on every size of screen

**Status:** Accepted · 2026-08-03 · **corrected the same day; see both amendments below**
**Source:** project owner, 2026-08-03, supplying a working HTML prototype of a control-room
display, then correcting what I built from it.
**Builds on:** ADR-0001 (the log is the record), ADR-0005 (silence is a signal), ADR-0009
(unassessed is a value, not a severity), ADR-0012 (what an alert may say in the open).

---

## Amendment — 2026-08-03, the same day

**This ADR originally decided to build a separate wall screen at `/display`, with its own
page, its own script and its own kind of credential. That was wrong and has been reversed.**

The owner shared the prototype to say *the things in it belong in our app.* I read it as
*build the thing in it.* The correction, verbatim:

> ye software just mobile ya laptop k lye nhe hai … ye mobile, laptop ya barre screen sub pr
> fit and zabardast chalega, software itna smart ho k agar koi mble pr sign inn kare tou
> mobile view dekhen, koi laptop/pc pr kare tou us ka view ajaye and agar koi office …
> agr barry screen pr daikna chalana chahe tou un ko barry screen ka hi view ajaye …
> **tum multiple screens bana kr complecated and messy naa banao**

And: *har department ka dashboard usy tarha rich hona chaye hai* — every department's
dashboard, not only the two offices'.

So the decision is now the opposite of what §2 and §4 below described:

| Was decided | Is decided |
|---|---|
| A separate page at `/display` | **One application.** The dashboard is a screen inside it |
| A screen signs in with its own token | **A person signs in.** A large screen in an office is somebody's session like any other |
| `wall_screen` table, issue/revoke console | **Deleted** (migration 0016). It only existed because the app had been split in two |
| A wall layout and an app layout | **One set of markup**, laid out by CSS at three widths |
| District aggregates only | **Scoped to the viewer** — the district for the two offices, its own work for a department |

What survives, because it was right for reasons that had nothing to do with the split:
**§1** (nothing private on a screen read by a room), **§3** (every value carries its own age),
and the two facts the district now reports about itself — utility status and officer presence.
Those are in §§1 and 3 below and still stand.

---

## Amendment — 2026-08-03, a cross-reference corrected

**No decision changed. One number did.** The Consequences section below cites **R-13** for the
question *which point should the weather be taken at* — but `R-13` was already taken, by
Rescue 1122's own list of response actions, raised a few hours earlier in the M1 gate entry.
One id, two questions.

**The weather question is now `R-16`.** The older row keeps the number it was given first,
which is the only rule that works on an append-only list: the alternative renumbers a row the
owner may already have written down.

The citation in **Consequences** is left reading `R-13` with this note above it rather than
silently edited, for the same reason the reversal above is left in place — *the ADR log is
corrected by appending, not by making the past look like it always agreed.* `R-15` (the
district's own facts — tehsils, union councils, population, area) was raised in the same
entry and had never been added to `backlog/for-the-district.md` at all; both are on it now.

---

## Context

Everything built before this was a **tool**: a thing a named person signs into, on a handset,
to do something. Report an emergency. Acknowledge one. Send a fire tender.

The prototype the owner shared was a **display** — the district's condition at a glance:
weather, public utilities, where the officers are, the published emergency numbers, counters
across the top. Their point was that the built app was thin next to it and should not be.

They are right. It was thin, and on anything wider than a phone it was a narrow column of
content with empty paper either side.

## Decision

### 0. One application that recognises the device

There is one codebase, one set of markup, and one feed (`GET /dashboard`). What changes with
the device is **how much of it stands side by side**, decided in CSS from the width the
browser already knows:

| | |
|---|---|
| **under 56rem** | a phone in one hand. One column, thumb-sized targets, the report form above the fold. This case must never regress — it is the officer standing at the scene |
| **56rem and up** | a laptop or a desk PC in an AAC's office. Two columns |
| **90rem and up** | a large screen on an office wall — the DC, the AC Headquarter, or anywhere else. Three columns, larger type, everything at once |

Nobody chooses a mode. There is no desktop version to keep in step with a mobile one. The
client reads the viewport in exactly **one** place — to decide which screen somebody *lands*
on after signing in (a phone lands on Report, a desk lands on the dashboard) — and that
chooses a starting screen, never a layout.

### 1. Nothing private, because a screen in an office is read by a room

A large screen in the DC office is read by whoever is standing there: a visitor, a contractor,
whoever walks past an open door. It is photographed.

**So the dashboard carries aggregates and never a particular person.**

| Shows | Never shows |
|---|---|
| "Incidents today: 4" | who reported them |
| "2 unassigned, oldest 11 minutes" | any reporter's phone number |
| "Rescue 1122 · 3 open" | any caller's name |
| the district's published emergency numbers | any officer's personal mobile |
| "AAC Mamund · in field" | where in the field |

Same reasoning as ADR-0012 on a different surface: an alert lands on a lock screen somebody
nearby can read, so it carries the *kind* and nothing that identifies anybody. Here the
surface is a room instead of a lock screen and the answer is the same.

This is not a convention. Every response is walked through `wallSafetyViolations` and a
violation **fails the request** rather than logging a warning. Stripping the offending field
would let a leak ship minus one column with nobody finding out; a dashboard that goes blank in
the DC office gets a phone call within the hour.

Rows still exist — on the **board**, where the authority model scopes them per incident, for a
person who has signed in and is looking at their own work.

### 2. Every value carries its own age

The prototype writes `Incidents Today: 2` and `Electricity (PESCO): Normal` in the same
typeface, side by side. One is counted from the event log a second ago. The other is a thing
somebody typed, possibly last Tuesday.

That confusion is most expensive on the screen people trust without touching. A room of
officers looking at a green dot that went stale nine hours ago is worse off than a room with
no screen — they would have phoned somebody.

**So each panel states when it was last true**, and past a threshold it stops asserting:

- counted from the log → live
- reported by a department (utilities, presence) → "PESCO · degraded · **2 hours ago**", and
  past the district's threshold the value greys and reads **"no report since 09:40"** instead
- fetched from outside (weather) → the age of the fetch, and on failure the age of what is
  still being shown

Not "Normal (stale)". A parenthetical after a word somebody has already read is a qualifier
nobody sees at four metres — the stale form is a **different sentence, about time**. The
server stops sending the status at all once it is stale, so no client can render it as
current even by mistake.

This is ADR-0005 on a dashboard. A stale green dot is silence wearing the costume of an answer.

### 3. Two new facts, reported by the departments that own them

**Utility status** — is the power on, the water, the gas, the line? **Officer presence** — is
the AAC in his office, in the field, or on leave?

Both follow the rule already set for the roster (owner, 2026-08-02): a department manages its
own data and nobody types on its behalf. PESCO says whether PESCO is up. The two offices may
report for anyone, because somebody has to be able to correct a department that has gone
quiet — visibly, through the same recorded path.

Presence is against a **seat**, not a person, so the panel keeps reading correctly across a
transfer, and so a screen in a public room names a post rather than a human being (ADR-0004).

`field` and `leave` must state when they end; `office` need not. "In office" degrades safely —
the worst case is a walk to an empty desk. The other two are claims the district plans around,
and one left open forever becomes a grey box nobody trusts and nobody fixes.

### 4. Weather is fetched by the server

Not the browser. One fetch every fifteen minutes serves every screen in the district; no key
is ever in a kiosk browser (Open-Meteo needs none); and a district whose line is down shows
**one** honest "last fetched" rather than each screen failing separately and differently.

A failed fetch changes nothing — the previous reading stays exactly where it is, ageing
visibly. That is a true statement. A blank panel would say nothing about whether the line is
down.

### 5. Nothing is entered on the dashboard

The prototype has an **Edit** button on every panel and a password in the JavaScript. Both
follow from having no backend: the display has to be its own admin because there is nowhere
else for the data to live.

Here there is somewhere else. `GET /dashboard` is the only method that answers; a POST to it
returns 405. Utilities and presence are reported through `/status`, emergencies through the
report form, configuration through the console — each in a place that knows who did it.

## What this rejects, and why

**A password in the page.** `const ADMIN_PASSWORD = "bajaur2026"` is readable by anyone who
opens View Source, and `isAdmin = true` in a console defeats it without even that. This is not
a weaker authentication; it is the absence of one wearing its clothes.

**A second page for large screens.** Rejected in the amendment above, at the owner's
instruction and for the reason they gave: two screens is two things to keep in step, and they
will drift.

**Incident rows on the dashboard.** Rejected in §1. The most requested feature of a
control-room display is the one it must not have.

**A single "last updated" clock for the whole screen.** Rejected in §2 — it is the
honest-looking version of the lie, making the freshest panel and the stalest look equally
current. Each panel owns its own age.

## Consequences

- `GET /dashboard`, session-scoped, returning only what §1 permits, with a permanent test that
  asserts the live response contains no phone number, no personal name and no coordinate.
- Two things the district now reports and the system did not previously hold, edited where the
  roster is edited.
- Weather fetched server-side on a fifteen-minute timer, with `WEATHER_LAT` / `WEATHER_LON`
  overriding the default point (R-13 asks the district which point it actually wants watched).
- Every existing screen — board, shift, console, roster — uses the same shell and gains the
  full width at large sizes. The 60rem and 64rem caps that made sense for a laptop are gone.
- Migration 0016 drops `wall_screen`. An unused table with a token column is an authentication
  path nobody is maintaining, and the next person to find it would assume it was load-bearing.
