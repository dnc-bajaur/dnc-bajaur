# ADR-0035 — On a page a human reads, the person's name leads the post

- **Status:** Accepted
- **Date:** 2026-09-07
- **Carries out:** the district's request, on reviewing a filed post-incident report
  (`DNC-BAJAUR-79`), that the officer's name come first
- **Narrows:** [ADR-0004](ADR-0004-duty-seats.md) for display only — authority is untouched

## The district's ask

The district reviewed a real printed post-incident report and asked for the acknowledger to
be shown by **name**, and for the name to come **before** the post everywhere it appears:

> *"pehle name ho us ke baad Post/seat"*

Every actor-naming site in the product led with the seat: `"Assistant Commissioner HQ Bajaur
(AC HQ)"`, `"District Nerve Center — District Nerve Center"`, `"set by <seat> — <person>"`.
Three of those sites carried a comment citing ADR-0004 as the reason.

## What was there, and why

ADR-0004 routes to a **duty seat**, not to a person, because the post is what carries the
obligation through a shift change. The display convention followed from it: *"the District
Control Room overrode this"* is the operational sentence, and the individual was the
supporting detail. The post-incident report went further and hard-coded the acknowledger's
`personName` to `null` — it could name who **reported** an incident but not who **confirmed**
it, because the fold carried only `acknowledgedBySeatId`.

## The decision

### On any page a human reads, the person's name comes first, then the post

`"Assistant Commissioner Ali Khan — AC HQ Bajaur"`, not the other way round. The officer's
name is what a DC office writes on a file and what an operator says on the telephone; the
post follows it. Applied at every actor-naming site: the post-incident report (screen, PDF
and the plain-text upward-submission export), the Record's incident drawer, the
Administration change log, and the daily report's *Responded by* cell.

### When the two strings would restate each other, print one

Bajaur's directory holds 79 single-person "departments" whose name restates the designation,
and control-room seats whose holder's name is the seat's name. `"District Nerve Center —
District Nerve Center"` is printed as `"District Nerve Center"`.

### The fold carries who acknowledged

`IncidentState` gains `acknowledgedByPersonId`, folded from the acknowledging officer — the
`acknowledged` payload's own `personId` first (the only trustworthy source on `route:
'operator'`, where the actor is the operator relaying a call), the envelope actor otherwise.
The daily report threads a `people` map through `DailySources` to use it.

### Diagnostic output is left post-first

`ops/integrity.ts`'s `doctor` labels name the **misconfigured post** — the post is the
subject of the finding there, not a person to quote — so those stay `"<post> (<holder>)"`.
This ADR is about pages that get filed and read, not about 02:00 diagnostics.

## What this is not

**It does not touch authority.** ADR-0004 stands: routing, override, acknowledgement and
every permission check resolve to the **post**. `acknowledgedBySeatId` is still the field the
SLA clock and `evaluateRead` read. Only the order of two words on a screen changed. A later
reader who finds `personName` first must not conclude that the obligation moved to the human.

## Consequences

- One shared `actorName()` helper in `domain/report.ts`; the client renderers
  (`web/src/report.ts`, `web/src/main.ts`, `web/src/admin.ts`) each keep their own small
  formatter, flipped, because they are separate bundles.
- A migration is not needed — `acknowledgedByPersonId` folds from events already in the log
  (`actorPersonId` has ridden every event since the start; the `acknowledged` payload's
  `personId` since M7-05).
- **Reversal cost: low.** Flip the helpers back and drop one folded field. No data moves.
