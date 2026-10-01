# ADR-0015 — The district composes its own dashboard

**Status:** Accepted
**Date:** 2026-08-05
**Reversal cost:** Medium — a panel registry, a layout document, and one editor. The panels
themselves do not change and keep working if the layout is thrown away.
**Builds on:** [ADR-0013](ADR-0013-one-app-every-screen.md) (one app, laid out by CSS) and
the `config_event` append-only settings log (M1a).
**Source:** the district, via the project owner, 2026-08-05.

---

## Context

Two requirements arrived together and they are the same requirement:

> Dashboard: Unified Screen (no scrolling)

> Mai ye bhi chahta hon k dashboard hum khud edit kar ske, es k elements add or delete kr ske,
> kese bhi options ko ju software mai maujod hain yaha par le aske.

The dashboard currently renders **fourteen panels**, fixed in `index.html`, in an order chosen
by whoever added them. On the screen the district will actually use — a laptop on an HDMI
cable to a television, so 1920×1080 — roughly eight or nine fit without scrolling.

**I could pick which six to cut. That is the wrong person deciding.** Every attempt to guess
which panels matter to a control room in Bajaur is a guess, and the last time this project
guessed at the district's structure it produced a four-tier hierarchy that ADR-0010 deleted.
The people who will stand in front of this screen at 02:00 know which panels they read and
which they have never once looked at. I do not.

So "no scrolling" is not a layout problem. It is an **ownership** problem, and solving the
second one solves the first for free: a district that chooses what goes on the screen chooses
an amount that fits.

## Decision

**The dashboard's contents are configuration, not markup.**

- **A panel registry**, server-side: every panel the software can draw, each with an id, a
  name in plain language, the authority required to see it, and the sizes it supports. Adding
  a panel to the product means adding a row here; nothing else in the system learns its name.
- **A layout document per scope** — one for the district view, one available to each
  department — naming which panels appear, in what order, at what size.
- **Layout changes are `config_event` rows**, like every other setting (M1a). Append-only, so
  *"who removed the performance panel, and when?"* has an answer six weeks later. A settings
  table holding only the current value cannot answer that, which is the same argument
  ADR-0001 makes about incidents.
- **The editor lives in the administration console**, beside the departments and the routing
  signals, and is administration-only.
- **A missing or corrupt layout falls back to a built-in default that fits 1920×1080.** The
  dashboard is never blank because a configuration row is wrong.

## Rationale

### Why a registry rather than free-form placement

The obvious build is a grid the administrator drops arbitrary things into. Rejected, because
every panel on this dashboard has an authority rule attached to it — `condition` is
administration-only on purpose, and the whole response is walked through
`wallSafetyViolations` because this screen is read by whoever is in the room (ADR-0013 §1).

**A layout engine that can place anything can place a phone number on a wall.** A registry
makes the safety rule a property of the panel rather than something the editor has to
remember, and an administrator who has never heard of `wallSafetyViolations` cannot
accidentally defeat it.

### Why the layout is data and not a preference blob

It is a decision about what the district watches. That is the same category of thing as a
routing signal or an SLA target, both of which already live in `config_event` for reasons
this project has already paid for. Storing it as a JSON blob in a settings table would make it
the one operational decision in the system with no history.

### Why "no scrolling" is not enforced

The editor **shows** how much space the chosen panels need against a 1080p screen, and warns
when they overflow. It does not refuse. A district that wants sixteen panels and accepts a
scroll on a desk PC is making a choice about its own screen, and software that overrules that
choice is software people work around by not using it.

## Consequences

### We gain
- The screen fits, because the people who read it chose what is on it.
- Adding a panel to the product no longer means arguing about what it displaces.
- A department can watch different things from the DC office, which was already true of the
  data and is now true of the layout.

### We give up
- `dashboard.ts` stays in the shell deliberately (it is the landing screen), and this adds to
  it. The shell budget is 131 KB against 160 — there is room, but the layout must be
  **delivered inside the dashboard feed**, not fetched separately, or the landing screen gains
  a second round trip.
- A configuration that can be got wrong. Hence the fallback, and hence the warning.

### We must therefore also
- Keep `wallSafetyViolations` running over the composed response, unchanged. The registry
  reduces the chance of a leak; it does not replace the check that fails the request.
- Give the editor a **preview at the target resolution**, because an administrator editing on
  a laptop cannot otherwise tell what the television will show.
- Ship the default layout as the one that fits, so a district that never opens the editor
  still gets a screen that works.

## Alternatives considered

**Pick six panels and ship a fixed screen.** Cheapest by a wide margin, and it was my first
proposal. Rejected by the district in the same breath as the requirement — and correctly,
because it makes every future panel a negotiation.

**Per-user layouts.** Rejected: this is a screen a room reads, not a person's workspace. Two
officers disagreeing about the control room's television is a conversation, not a feature.

**A general drag-and-drop grid builder.** Rejected as disproportionate — and as the thing that
makes the authority rules unenforceable, above. Ordered panels at three sizes cover what was
asked for.

## How we would know this was wrong

- **The editor is opened once, at installation, and never again.** Then the district wanted a
  good default, not a builder, and the registry is machinery serving one afternoon's work.
- **Every scope converges on the same layout.** Then per-scope layouts are ceremony and one
  district-wide layout would do.
- **A layout is found that hides something an invariant depends on** — the unmet-notification
  count, or the not-live banner. Those are not panels and must never become configurable; if
  one has, the registry drew its boundary in the wrong place.
