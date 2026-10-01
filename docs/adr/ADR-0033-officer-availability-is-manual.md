# ADR-0033 — Officer availability is a manual Available/Unavailable roster the wall can carry by name

- **Status:** Accepted
- **Date:** 2026-09-01
- **Amends:** [ADR-0013](ADR-0013-one-app-every-screen.md) §1 (a curated on-duty roster may carry
  officer names on a wall screen), [ADR-0004](ADR-0004-duty-seats.md) (availability is stated
  against the post, and the wall names the person who holds it)
- **Supersedes in part:** M9-31 (the five-answer presence list), M9-32/M9-35 (`NEEDS_END`)

## The district's ask

> *"wo chahte hain k Officers availibity by hum khud hi check kar skte ho, yaani k ju officer
> avaialble hai unko available and ju nhe hai un ko unavailable mark hum manual kare … then we
> should select available officer to dashboard from status … name aur desg ki sath dashboard par
> ane chye hai."*

Three things:

1. The Status screen carries a **manual** Available / Unavailable control per officer. Nothing
   auto-marks, nothing resets on a timer, nothing expires. The control room sets it and the
   control room is the only thing that changes it.
2. From Status, the control room **picks which available officers** appear on the Dashboard wall.
3. On the wall each picked officer reads as **name + designation**.

## What was there

The Status screen's *"Where the officers are"* section (M9-31) is a five-answer list —
`present · absent · office · field · leave` — set against the **post**, with `absent`, `field` and
`leave` each required to state an end (`NEEDS_END`, M9-35). The same five answers ride the WhatsApp
*"where are you?"* list message (Phase C2), the `/ack/` token page, and the daily report's presence
block. The Dashboard `presence` panel shows the post title and the location label, **never the
officer's name** — ADR-0013 §1: *a wall screen is read by whoever is in the room*.

## The decision

### Availability is two states, and it is manual

`PresenceStatus` becomes `'available' | 'unavailable'`. `NEEDS_END` is removed. There is no
`until_at` to fill in, no auto-reset, no staleness cap — a reading stands until the control room
changes it, which is what *"hum manual kare"* means. This is ADR-0025's answer to the utility
timer, applied to presence: nothing polls an officer's location, and a duty officer typed one
answer because that is the situation, not because a sensor read it.

The location detail — *in office* versus *in the field* — is genuinely lost. The district asked for
it: a control room at 02:00 is answering one question, *can I send this to them?*, and
Available/Unavailable is the whole of that answer. Where they are is on the incident once they
reply.

### The WhatsApp flow maps onto the two states, so no Meta template changes

The *"where are you?"* list message goes from five rows to two — `Available` / `Unavailable`. It is
already a session-window list message (`sendSession`), not a template, so **nothing is submitted to
Meta and nothing waits**. An officer who taps `Available` on WhatsApp lands on the same record the
Status screen writes.

### The wall carries the officer's name — a scoped exception to ADR-0013 §1

ADR-0013 §1 forbids *nothing private on a screen a room can read*, and the `presence` panel has
respected that by showing the post, never the holder. `wallSafetyViolations` enforces it by
**shape** (a phone number, a coordinate) and by **known-private key** (`fullName`, `reporterName`,
`personId`, `address`, `description` — reporter PII lifted from an incident payload).

An **on-duty officer's name beside the post they hold** is a different thing from a reporter's
name lifted off an emergency. It is operational information the control room chose to put there,
about their own staff, and the district asked for it in as many words. So:

- The `presence` panel row gains an optional `officer` field — the holder's name. `officer` is
  **not** added to `wallSafetyViolations`' `FORBIDDEN_KEYS`; a bare name string matches neither
  the phone nor the coordinate shape, so it passes the guard. The guard still stops a phone
  number or a coordinate appearing there, and still stops the reporter-PII keys.
- The name is only carried for a seat the control room has **curated onto the wall**
  (`seat.on_wall = true`). An officer nobody picked is not named on the wall; their availability
  is still visible on the Status screen, which is the control room's own surface.
- The name is resolved from **today's roster** at render time — the same documented limitation the
  incident-detail screen already carries (M0-35): the event records the post, and renaming the
  post retitles it through history. Availability attaches to the post (ADR-0004); the wall names
  whoever holds it now.

### The curated pick is a flag on the seat

`seat.on_wall boolean not null default false`. The Status screen toggles it. The Dashboard
`presence` panel shows exactly the seats where `on_wall` is true, with the holder's name, the
designation, and the current Available/Unavailable state (or *not reported* — ADR-0005, a gap is
stated). A seat with `on_wall = false` is not on the wall at all.

This is not `config_event`-logged. It is a display preference the control room adjusts as shifts
change, the same class of thing as the dashboard layout's own per-panel choices — not a fact about
the district's structure that a future reader needs the history of.

## Consequences

- **Migration 0046** rewrites `presence_report.status`'s CHECK to `('available', 'unavailable')`
  and folds the old values in — `present`/`office`/`field` → `available`, `absent`/`leave` →
  `unavailable` — so nothing on Bajaur's wall reads wrong after the deploy. It adds `seat.on_wall`.
  **No `RAISE`, no guard in the migration** (O-40): the value fold is deterministic and there is
  nothing to refuse over.
- The WhatsApp *"where are you?"* list, `/ack/`'s availability form, and the daily report's
  presence block all speak the two words. `WHERE_ROWS` in `domain/stages.ts` and the mapping in
  `api/webhooks.ts` shrink to two.
- `NEEDS_END`, `presenceAge`'s `until_at` handling and the `until` datetime control on the Status
  screen are removed. `presence_report.until_at` stays on the table, inert, on ADR-0025's
  precedent for `stale_minutes`.
- `docs/01-invariants.md` INV-02's note is unchanged: presence is still *dated* — `asOf` /
  `ageMinutes` ride every reading and the wall prints the age — it just no longer *degrades*,
  because the district asked for the timer gone.
- The `presence` panel's `audience` stays `all` and its authority scoping is unchanged. A
  district that has never curated a seat onto the wall gets an empty panel, which reads as
  *nobody on the wall* rather than as broken.
