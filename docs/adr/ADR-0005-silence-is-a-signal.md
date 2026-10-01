# ADR-0005 — Absence of reports is never rendered as "normal"

**Status:** Accepted
**Date:** 2026-08-01
**Reversal cost:** Medium — projection semantics and UI

## Context

The most dangerous failure mode of a district dashboard is not a crash. It is a **calm
green screen during an actual crisis.**

This happens when a department stops reporting — because it is offline, because it is
overwhelmed by the very emergency in question, or because it has quietly stopped using the
system. A dashboard that computes "district status: normal" from an absence of incidents
will reassure a DC at exactly the wrong moment, and will do so with complete confidence.

The failure is systematic, not incidental: the fewer reports arrive, the calmer the
dashboard looks. The signal inverts precisely when it matters.

## Decision

**Absence of data is an alarm state, not a normal state.**

- Every department carries a **heartbeat** with an expected interval, configured per
  department.
- A department past its interval renders as **NO CONTACT** — never as **NORMAL**.
- Every derived summary carries **coverage**: which departments and areas it actually
  includes, and which are missing.
- **No aggregate may be rendered without its coverage.** "3 incidents district-wide" is a
  lie if two of six tehsils have not reported in nine hours.
- "District status: normal" is computable **only** when no critical is open *and* coverage
  is complete. Otherwise the status is "partial visibility" with the gaps named.

Degradation is never colour-only — it carries text and an accessible state (INV-02).

## Rationale

A dashboard's implicit claim is "this is what is happening." When it cannot see part of
the district, its honest claim is narrower: "this is what I can see, and here is what I
cannot."

Making that distinction structural rather than a footnote is the difference between a
decision-support tool and a false-confidence machine. The DC's question is not "how many
incidents are open" — it is "is the district under control", and the answer to that
depends as much on what the system cannot see as on what it can.

Heartbeats also give the system an early warning about adoption decay. A department whose
heartbeat degrades over weeks is a department drifting back to phone calls — visible as an
operational signal long before it shows up as a bypass-rate problem in a pilot review.

## Consequences

### We gain
- INV-02 and INV-04 become enforceable at the projection layer rather than per-screen.
- Adoption decay becomes observable in real time.
- The central board's claims are honest about their own limits.

### We give up
- A clean green dashboard. Real districts will frequently show partial coverage, and this
  will be uncomfortable. That discomfort is the point — but it must be presented so it
  drives action rather than becoming background noise.

### We must therefore also
- Calibrate heartbeat intervals per department against real operating rhythms. Too tight
  produces constant amber and alert fatigue, which destroys the signal entirely. Too loose
  and it detects nothing. **This is tuned during the pilot with real departments, not
  guessed.**
- Distinguish clearly in the UI between "nothing is happening" and "we cannot see" —
  these must not share a visual treatment.
- Provide a cheap, one-tap way for a department to say "nothing to report" so that
  heartbeat compliance does not require inventing incidents.

## Alternatives considered

**Freshness timestamps only, without an alarm state.** This is what the original handbook
specifies. Rejected as insufficient: a timestamp in small text next to a large green
"NORMAL" does not stop anyone from reading the green. The state itself must change.

**Assume no news is good news.** Rejected — this is precisely the failure mode described
above.

**Require a mandatory periodic report from every department.** Rejected as too heavy for
v1 and likely to produce compliance theatre — empty reports filed to satisfy a system.
The one-tap "nothing to report" is the lighter version of this idea and is included above.

## How we would know this was wrong

- Operators habituate to a permanently amber board and stop reading the coverage
  indicator — meaning the thresholds are wrong, or the presentation has become noise. Both
  are fixable, but both would need to be caught in the pilot.
- Departments game the heartbeat with meaningless check-ins, making compliance high and
  the signal worthless. That would indicate the heartbeat needs to be tied to genuine
  activity rather than a button press.
