# ADR-0036 — A dashboard panel expands into a read-at-rest drawer

- **Status:** Accepted
- **Date:** 2026-09-07
- **Carries out:** the district's request, on reviewing the wall, that a panel carrying more
  rows than fit be openable in full
- **Narrows:** the `DashboardLinks` note in `web/src/dashboard.ts` — "the dashboard
  deliberately grows no detail view of its own" — for the panel's **own list**, not for a
  view beside it
- **Rests on:** [ADR-0015](ADR-0015-the-district-composes-the-dashboard.md) (the panels are
  the unit), and the drawer pattern Administration / Settings / the Record already use

## The district's ask

On the wall, several panels hold more rows than fit and the extras travel: `flowPanels` wraps
a long panel in a moving film, and the news and *Still running* tracks scroll. Reading every
utility or every service therefore means waiting for the rotation to come round.

> *"jis tarha baki application mai details k lye right side mai Drawer open ho jata hai … isi
> tarha yaha bhi 'Expand in Drawer' ho, us pe click karne se right mai wo pura card hi open ho
> jaye"*

And, in the same breath, that the wall's own click-throughs are **not** to change:

> *"currently Dashboard pe click karne se jahan jata hai wo bilkul sahi hai, use change nahi
> karna … drawer ke andar se bhi agar koi kisi cheez pe click kare to wo waise hi us jagah
> chala jaye jaise dashboard se jata hai"*

## The decision

### 1. The panel's heading is an "expand" control

Every panel whose rows travel gets its `<h2>` wired as `role="button"` with a corner glyph
that shows only on hover or keyboard focus — a resting wall is unchanged. The heading, not a
new button: the district asked for the header. Skipped: **District** (`keys`) and **Emergency
situation** (`situation`), which are read in one glance already, and the `outside` frame,
which has no list of its own. Every other panel is in — including Weather and Pakistan
headlines, at the district's request, because the headlines scroll too.

### 2. Expanding MOVES the panel's list into a shared drawer

The list node itself — `#dashUtilities`, `#dashNews`, … — is lifted out and placed in the
drawer, not copied. A clone would lose the `leadsTo` click handlers (added with
`addEventListener`, not inline) and would freeze at one poll's values. The moved node keeps
its id, so the twenty-second poll finds it wherever it now lives and keeps it current;
`flowPanels` skips it while it is away; the travel CSS is suppressed inside the drawer so the
list sits still. On close the node returns to a comment marker left in its place, and the next
paint rebuilds the travelling film around it if it had one.

### 3. The drawer is `web/src/drawer.ts`, shared and new

The app slides a panel in from the right in three places already — `admin.ts`'s
`createDrawer()`, `settings.ts`'s private `openDrawer`, and the Record's `#detailView` wired
by hand in `main.ts` — each a separate copy, agreeing to about ninety per cent. `drawer.ts`
is the behaviour written once (backdrop, slide, Escape, click-outside, focus return,
single-instance); the look is the shell's `.od-*` block, on the same tokens and measurements
the Record's drawer uses.

### 4. Inside the drawer, a row leads exactly where it led on the wall

The handlers are the same nodes' own. What the drawer adds: once that navigation fires, the
drawer has done its job, so it closes itself. An external headline link (new tab) is not
leaving the screen and leaves the drawer up.

## What this is not

**It is not a detail view.** The `DashboardLinks` note stands: the dashboard still hands off
to the board, to Status and to the console for anything a row raises, and it does not render a
thing *beside* those. The drawer shows the panel's **own list**, at rest, and then gets out of
the way. A second incident view beside the board's — the failure that note describes — is not
created here.

**It does not fold in `#detailView`.** The Record's drawer is welded to one incident (it
fetches `/incidents/:id`, drives `showView('detail')`, and its markup has `timeline` /
`whoTold` / `#takeAction` children). Converging it onto `drawer.ts` is a separate change with
its own risk and is left as future work.

## Consequences

- New: `web/src/drawer.ts`, bundled into `dashboard.js` (it is `dashboard.ts` that imports
  it); the shell's `.od-*` CSS block; `mountExpanders()` / `expandPanel()` in `dashboard.ts`,
  called from `paint()` beside `makeCard`.
- `web/src/__tests__` — none; the behaviour is DOM-and-navigation and is covered by
  `src/__tests__/panelDrawer.e2e.test.ts` (node identity across the move, the row hand-off,
  the skip list).
- **Reversal cost: low.** Drop `drawer.ts`, the `.od-*` block and the two functions; the
  panels go back to travel-only. No data, no server, no schema.
