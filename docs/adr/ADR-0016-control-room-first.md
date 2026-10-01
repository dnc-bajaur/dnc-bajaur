# ADR-0016 — The control room is the product; everything else is hidden, not deleted

**Status:** Accepted
**Date:** 2026-08-05
**Reversal cost:** Low — one capability flag and a navigation rule. Nothing is removed, so
reversal is turning the flag back on.
**Amends:** [ADR-0013](ADR-0013-one-app-every-screen.md) — one app on every screen still
holds; what changes is which screens a given seat is offered.
**Source:** the district, via the project owner, 2026-08-05.

---

## Context

> Their number 1 priority for now is to make it for their control room only.

The system was built outward from a field officer's handset: rapid intake in under fifteen
seconds, a durable offline outbox, layered location capture, evidence upload, department
workspaces, a fleet. All of it works and all of it is tested — the M0 gate cuts the network
at the driver and proves an emergency survives it.

**None of that is what the district is using.** They have one control room. Alerts arrive
there by telephone. One operator writes them down and forwards them by hand. The field
handsets the architecture was shaped around are, today, not in anybody's hand.

The tempting conclusion is that the offline substrate was wasted effort and should be removed
to simplify the product. That conclusion is wrong twice over, and this ADR exists to say so
before somebody acts on it.

## Decision

**The application presents the control room's work and nothing else, by default. Every other
screen stays in the codebase, stays tested, and is reachable behind a capability the
administration turns on.**

- The control-room seat lands on the dashboard and works from **intake → select recipients →
  send → track**. That is the product.
- **Hidden by default:** field rapid-intake, the shift screen, department workspaces, evidence
  upload, the fleet/resources screens.
- **Not hidden, ever:** the event log, the offline outbox, the sync protocol, server-side SLA
  and escalation, the delivery ledger, the authority model. These are not screens.
- **Nothing is deleted, no migration drops a table, and no test is removed.** `npm run check`
  stays green across all 767 of them.

## Rationale

### Why the offline substrate stays even though the control room is on a desk

Two reasons, and the second is the one that matters.

The first: Bajaur's power and internet are the unreliable part. A control-room laptop on an
HDMI cable loses its connection exactly as readily as a handset does, and when it does, the
outbox is what stops an emergency being lost between the operator typing it and the server
hearing about it. **INV-01 is not a field-officer feature.**

The second: the offline path is what INV-01's proof *is*. `spine.e2e.test.ts` is the M0 gate —
a real emergency, a real browser, the network genuinely cut, delivering itself on reconnect.
Remove the substrate and the gate does not fail, it **disappears**, and the strongest claim
this project can make about itself becomes unevidenced. A test suite that gets smaller when
scope narrows is a test suite that was measuring scope, not correctness.

### Why hidden rather than deleted

Deleting is cheap now and expensive to undo. The district has one control room *today*; the
thesis this platform was funded against is district-wide coordination, and the field screens
are the second half of it. Migration 0018 is the precedent worth reading: a table was dropped
for excellent reasons on 3 August, and [ADR-0014](ADR-0014-the-software-sends-again.md) is
rebuilding a version of it forty-eight hours later.

**Deleting working, tested code because it is not this quarter's priority is a decision to pay
for it twice.**

### Why a capability and not a comment

A screen hidden by commenting out a nav button is a screen that rots — it stops being built,
stops being styled, and is broken by the time anybody turns it back on. A capability flag
keeps it compiled, keeps its tests running, and makes turning it on an administrative act
rather than a release.

## Consequences

### We gain
- One obvious path through the application for the person who actually uses it. The control
  room is not asked to ignore nine tabs that are not theirs.
- A smaller surface to get right for the first real deployment.

### We give up
- The shell still carries code for screens most users never see. Acceptable: the office
  screens are already lazy (`office.js`), and the shell sits at 131 KB against its 160 KB
  budget.
- A flag that can be set wrong, and a second configuration to reason about when a screen is
  missing. Mitigated by making it visible: the administration console shows what is on and
  what is off, rather than leaving "why can't I see the fleet?" to be diagnosed.

### We must therefore also
- Keep the hidden screens in `npm run check` and in CI. A hidden screen that stops compiling
  is a deleted screen with extra steps.
- State the flag's value on `/health`, so an installation's actual shape is answerable without
  signing in.
- **Not let "control room only" narrow the authority model.** Scoping is still per seat and
  server-side; hiding a tab is presentation, and §7's rule that the UI is never the
  enforcement layer (INV-05) applies to this ADR exactly as it applies to everything else.

## Alternatives considered

**Delete the field and department screens.** Rejected above. The reversal cost is the whole
argument.

**Ship everything and let the control room ignore what is not theirs.** This is the status
quo, and the district asked for it to change. Nine tabs on a screen where two are used is how
an operator learns to stop reading the screen.

**A separate control-room build.** Rejected: it is ADR-0013's `/display` mistake wearing a
different hat. Two builds diverge, and the one nobody is watching is the one that breaks.

## How we would know this was wrong

- **The district asks for a hidden screen within weeks** — then the default was drawn too
  tight, and the flag should start out permissive.
- **The flag is never changed by anybody, in any installation, for a year.** Then it is not a
  capability, it is a fork, and the honest move is to admit the field half is out of scope and
  say so in `docs/07-capabilities.md`.
- **A bug is found in a hidden screen that nobody noticed because nobody looks at it.** That
  is the rot this ADR claims a flag prevents. If it happens, the flag did not prevent it.
