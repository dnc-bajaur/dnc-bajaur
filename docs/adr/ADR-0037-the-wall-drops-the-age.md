# ADR-0037 — The wall's status cards carry no age. The district reads them as current.

**Status:** Accepted · 2026-09-08
**Decided by:** the project owner, relaying the district, after being shown INV-02 and ADR-0025
and offered a middle option — and choosing removal anyway, on the second asking.
**Amends:** [INV-02](../01-invariants.md#inv-02--stale-data-is-never-rendered-as-current) — the
two condition panels no longer satisfy it by **either** of its two forms. This is the first place
in the product where that invariant is knowingly not met.
**Narrows:** [ADR-0025](ADR-0025-a-utility-report-has-no-expiry.md) — which said in as many
words that *the age is not optional*, and named its removal as the way a future screen would
break INV-02. That screen is this one, and it is not a future accident.

---

## Context

ADR-0025 removed the staleness timer from utilities because the district asked for it: *"control
wale control karenge, close karenge."* A report stands until somebody replaces it. That ADR then
had to answer INV-02, and answered it with the age: **the value stays, and how old it is stands
printed beside it, climbing between polls.** It said so plainly, and said what it was giving up:

> ⚠️ **What this gives up, stated plainly.** A service nobody has touched for three days now shows
> its last status in full colour with a three-day age beside it, where it used to grey out on its
> own. … The mitigation is the age, and the age is not optional — if a future screen renders a
> utility status without it, that screen breaks INV-02 and this ADR is the reason why.

On 2026-09-08 the owner, watching the wall in the room where it hangs, asked for exactly that:

> *"dashboard mai status panel sai ju chezen ati hain jese k: District services, Public
> utilities, Officers … en k sath ju time show hota hai jese k: 1 hr ago, 2 days ago, 4 days ago,
> 3 hr ago etc etc, ye time yaha par show nhe hona chaye hai, YE SAHE NHE lag raha hai."*

They scoped it to the Status screen first, and that shipped as `dnc-shell-v239` with the wall
deliberately untouched and a capital-letter comment saying why. **They read that sentence back as
the defect rather than the safeguard**: *"yaane k dashboard pr time abhi bhi dikh jaega????"*

They were then shown this ADR's own warning, INV-02's wording, and a middle option — print the
age only once a reading goes old, so a fresh card is clean and a four-day-old one still says so.
They chose removal. That is the second asking, with the cost in front of them.

## Decision

**`renderStatusList` prints no age.** District services, Public utilities and Officers render the
name, the officer where there is one, the status pill and the district's own note — and nothing
about time. `nobody has reported this` stays, because it is a statement about *absence of a
report*, not about the age of one.

**Nothing else on the wall changes.** Alerts, the carried-over band, incidents, weather and the
Pakistan headlines still print their age through `ageSpan` and still climb through `startAges`.
The machinery is untouched; one call site is gone.

## Rationale

**The district is the party INV-02 protects, and it is telling us what it wants protecting
from.** The invariant exists so a control room is never misled by an old number. The people in
that control room have now said twice that on this wall the ages were noise — four cards deep in
grey text about time, on a screen read from four metres — and that the noise cost them more than
the staleness it warned about. An invariant defended against its own beneficiaries stops being
an engineering safeguard and becomes a disagreement we keep losing quietly.

**Officers lose nothing real.** Presence still expires. A stale availability row still greys
through `toneFor` and still takes the `last said:` prefix on its note — INV-02's **degrade** form,
which never needed a number to work. For that panel this change is cosmetic.

**The two condition panels are the honest cost, and it is not small.** They have no expiry to
degrade through, by the district's own instruction in ADR-0025. With the age gone they satisfy
neither form of INV-02: a *Normal* from four days ago is pixel-for-pixel a *Normal* from a minute
ago. We are not claiming this is safe. We are recording that the district was told, in these
words, and chose it — and that the way back is one line in `renderStatusList`.

## Consequences

### We gain
- Three panels of the wall read as four short lines a person scans, not as a table of timestamps.
- The Status screen and the Dashboard now say the same thing about time, which is *nothing* — one
  vocabulary instead of two for the same three panels.

### We give up
- **INV-02, on District services and Public utilities.** Stated without softening. This is the
  first knowing exception in the product, and it is written into the invariant itself so nobody
  finds it by surprise.
- The ability to tell, from the wall alone, that a service has gone quiet. The gap counter
  (*"N not reporting"*) still answers it for services that never reported; it does not answer it
  for one that reported once, four days ago.

### We must therefore also
- Keep `dashboardLive` test 25 (all three panels, zero `[data-since]`, rows asserted present) and
  its sibling — test 18's `#dashCarriedOpen .cage` — as a pair. One holds the removal, the other
  holds the scope.
- Leave `ageMinutes` / `asOf` on the projection. The data is unchanged and every other consumer
  (the daily report, the Status screen's own reporting, exports) still reads it. This is a
  rendering decision, not a data one, and that is what keeps the reversal cheap.

## Alternatives considered

**Print the age only past a threshold** — fresh cards clean, an old one carrying `4 days ago`.
This was the recommendation: it answers the owner's actual complaint (constant grey noise) while
keeping INV-02's warning exactly where it matters. It lost because they were asked directly and
did not pick it. Recording it here because it is the shape any future revisit should start from.

**Shrink or dim the age instead of removing it** — rejected before it was offered. It is the
worst of both: still noise, and now unreadable at the distance the wall is read from.

**Restore expiry for utilities so they degrade instead** — this reverses ADR-0025 and the
district's *"auto reset etc ye nhe hoga"*. Trading one refused decision for another.

## How we would know this was wrong

**The signal is an operational one, and it will be specific.** A district officer acts on a
service's status — dispatches, reports upward, tells somebody the power is on — and it turns out
the last report was days old and nobody could tell from the screen. One such incident is enough;
it is exactly the failure INV-02 describes, and it would mean the threshold option above should
have been taken.

The weaker signal to watch for first: the control room starts asking *"ye kab ka hai?"* about a
card, or opens the Status screen to check a date it used to read from the wall. That is the same
need reappearing before it has cost anything.
