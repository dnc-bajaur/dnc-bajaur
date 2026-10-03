/// <reference lib="webworker" />

/**
 * The service worker. M0-12.
 *
 * Its only job is to make the app **openable** with no network. Without it, a handset that
 * closed the browser during a shutdown cannot reach the app at all — the queued report is
 * safe on disk and completely unreachable, which in this district is a failure.
 *
 * The single most important rule in this file is the one that says what NOT to cache.
 */

declare const self: ServiceWorkerGlobalScope;

/** Bump to ship a new shell. Old caches are deleted on activate. */
// v3: the responsive shell (M4), and `/dashboard` and `/status` joining NEVER_CACHE. A
// browser holding an older cache keeps serving the stale shell until this version changes.
//
// v4: the office screens, search and the post-incident report left `app.js` for their own
// files, and their styling left `index.html`. **Both halves of the shell changed and this
// line did not**, so every browser that had ever opened the app kept serving the old one —
// the exact failure the note above describes, committed four times in a row without anybody
// noticing, and found by somebody opening the app and asking where the dashboard had gone.
//
// The lesson is not "remember to bump it". It is that **nothing enforced it**: the shell can
// change in a file this one never mentions, so `sw.e2e.test.ts` now fails when the built
// shell's bytes change and this string does not.
// v5: the district counters became clickable, so `index.html` gained their styling and
// `app.js` gained the filters they lead through. Caught by `shellVersion.test.ts` on its
// first real outing — it failed this change before anybody had to notice it by hand.
// v6: the dashboard stopped starting a second fetch while one was in flight.
// v7: the application got icons. `index.html` gained the favicon and `apple-touch-icon`
// links, and the manifest gained the 192 and 512 Chrome requires before it will offer
// "Install" at all — so until this shipped, the one thing ADR-0013 is built around, an
// officer opening this like an app on their own handset, was not being offered.
// v9: ADR-0018. The inbox left the shell entirely — its nav button, its screen and its fetches
// — and the "Who was told" panel gained the control an operator uses to record what they were
// told on the telephone (M7-08). Both halves of the shell changed, which is exactly the case
// `shellVersion.test.ts` exists to catch.
// v10: "My department" and the dashboard's `Unassigned` counter left the shell (2026-08-06).
//
// **And a warning about how this nearly went wrong.** v9 shipped early in the same session, and
// the shell then changed four more times — the reports block, the message-kind select, the
// dispatch bundle split, and these two removals. Each time `npm run shell:record` was run and
// the version was **not** bumped, so `shellVersion.test.ts` went green every time while every
// browser holding v9 would have kept serving the shell from the first change.
//
// `shell:record` is a separate command so a human decides; running it reflexively after a red
// check turns the guard into a rubber stamp. **Bump this first, then record.**
// v11: the console stopped calling eighty departments broken — the red "nothing will ever reach
// this department" line and its amber card tint went, and `open-unassigned` left the sweep.
// v12: the board stopped telling the district to write routing signals. The banner, the
// "nobody told" tally, "nobody told yet" on a row, and the real reason a message failed
// instead of "could not notify the duty seat".
// v13: the in-product guide. `index.html` gained a nav button and an empty container for it
// (`help.ts`, fetched lazily like search and report) — the shell changed even though the guide
// itself did not ship inside app.js, which is exactly the shape v4's note above warns about.
// v14: the "Signal" palette (2026-08-11) — every colour token in `index.html`'s `:root`,
// the header/mark/clock glow effects tied to them by hand, the manifest and meta theme-color,
// and the border-radius scale softened toward the rounder cards the new palette calls for.
// v15: the confident-numeral treatment (weight 800, tight tracking, tabular nums) carried from
// the district counters into the board summary strip, the admin performance and fleet tallies,
// the weather panel, the response-time panel and the district facts panel.
// v16: the board's doorbell (M8) — `/board/live` joins NEVER_CACHE (a stream that never ends
// would otherwise hang the service worker's own `cache.put()` forever, silently), and the
// board's rows are reconciled in place rather than rebuilt, with an `.entering`/`.updated`
// flash in `index.html` for the row it happened to.
// v17: same day, same feature — `.updated` was flashing every already-overdue row at once
// whenever a refresh happened to straddle a shared minute boundary, because comparing rendered
// text picked up `overdueByMinutes` ticking on its own. `applyBoardRows` in `main.ts` now
// compares a signature that excludes it, so the flash means "something happened", not "a
// clock advanced" — found by watching two real tabs, not by a test.
// v18: the filled buttons now take `--primary-fill`/`--critical-fill` (2026-08-12), because the
// "Signal" palette's `--primary` and `--critical` were each doing two jobs and failed AA under
// white text as a solid fill — measured, not eyeballed. This bump also matters for `help.css`,
// which is NOT in `SHELL` but is cached by the generic handler under this very version string,
// so a browser holding v17 would otherwise keep the guide's old button colours indefinitely.
// v19: `/privacy` and `/terms` are not the application. Caddy serves them from files so that Meta
// can publish the app — an unpublished app receives no webhooks at all — and the navigation
// branch was answering them with the cached shell, so the district's own privacy link opened the
// report screen on every browser that had ever run the app. This bump is what actually delivers
// the fix: a handset holding v18 keeps the old service worker, and the old service worker is the
// bug.
// v20: `/data-deletion` joins them, for the same reason and the same Meta requirement — its app
// settings ask for a user-data-deletion URL beside the privacy and terms ones. Worth noting what
// this bump does NOT do: v18 and v19 were never deployed, so the live server was still serving
// v17 when this was written, and the /privacy fix v19 describes had therefore never reached a
// single handset. One deploy now carries all three.
// v21: the acknowledge button reads **Acknowledged**, at the district's request, replacing "I
// have this" — in `help.ts`'s mock button as well as in the template definition and the wording
// a human pastes into Meta, because the three have to say the same thing or the guide teaches an
// officer a button that does not exist. **This bump is the whole reason the change reaches
// anybody**: `help.js` is not in `SHELL`, so it is never precached, and the generic handler holds
// it under this string — a browser on v20 would have kept the old guide indefinitely. The digest
// did not cover `help.js` either until today; see `shellDigest` in `build.mjs`.
// v24: two shell changes, and **one of them has already been deployed under v23**. Phase 4a
// stripped 17 KB of HTML comments out of the built `index.html` and added the "Tell all 8"
// styling; the digest was re-recorded and this string was not moved, which is precisely the
// half-fix `shellVersion.test.ts`'s message warns about — every handset already holding v23 kept
// the old shell, and no amount of deploying would have changed that. Phase 4b's directory forms
// (M9-23) are the second change. This bump is what actually delivers both.
// v33: a meeting notice stops looking like an emergency on the board (M9-11) — the kind chip and
// its styling in index.html, the branch in app.js. Both halves of the shell.
// v32: THE GUIDE CATCHES UP WITH M9 — meetings and notices, attachments, telling a whole
// department, what an officer can do from the message, availability, correction, and the daily
// report. **help.js is NOT in SHELL**, so it is held by the generic handler under this string and
// a browser on v31 would keep the pre-M9 guide indefinitely — teaching an officer six screens
// that have moved. v21 says the same thing about the same file; this is the third time.
// v31: the WEATHER PANEL IS BACK (the owner's instruction, "har surat mai") and a Pakistan
// headlines panel joins it (M9-59) — new markup and styling in index.html, a new renderer in
// app.js. Both halves of the shell.
// v30: correction, not deletion (M9-52/53) — the "corrected" chip and the correction note in
// index.html, and "Correct this" in app.js. Both halves of the shell.
// v29: the daily report is reachable (M9-46) — two links in the Reports block, in index.html.
// v28: THE WHITE PALETTE (M9-41..45). Every token in index.html's :root, the five hand-written
// --primary glows, the modal scrim, the row-arrival flash, help.css's border, theme.css, the
// <meta theme-color> and build.mjs's manifest colours. **This bump is what delivers any of it**:
// help.css is not in SHELL and is held by the generic handler under this string, so a browser on
// v27 would have kept the guide's old colours against a white page indefinitely (v21 says the
// same thing about the same file).
// v27: the dashboard gains "Last 24 hours" (M9-38/40) — its markup, its row styling and the
// line that says how many more there are, all in index.html, which is the shell.
// v26: the five availability answers reach the Status screen (M9-31) — two new buttons and their
// styling, in index.html, which is the shell.
// v25: the four stages reach the board (M9-25) — a chip on every row and the word in the detail
// heading, both from `index.html`'s stylesheet, which is the shell. Bumped **the same hour** v24
// went out, deliberately: v24's own comment is about a shell that changed under an unchanged
// version, and "it only just deployed" is exactly the reasoning that produced that fault.
// v35: the UI/UX foundation pass (2026-08-14), in two halves that ship together.
//   (a) The office screens' and the recipient picker's CSS left the shell (`office.css`,
//       `dispatch.css`), and the inbox's and the alert ladder's styling was deleted outright —
//       both had been drawn by nothing since ADR-0018 and ADR-0012's supersession. 157.1 KB ->
//       130.8. **Two new files are now fetched at runtime**, held by the generic handler under
//       this string exactly as `help.css` is: a browser on v34 would otherwise keep the old
//       office styling for ever, which is the fault v21's note describes.
//   (b) The structural scales and one focus ring for everything, in `index.html`'s `:root`.
// Both halves are under ONE version deliberately, and this is not the rubber-stamping v9's note
// warns about: **v35 has never left this laptop.** Nothing has ever served it, so no browser can
// be holding it, and the version and the bytes reach a district together for the first time.
// Re-recording the digest without a bump is only a formality when somebody already has the old
// one. Fold a later change into this line only while that is still true.
// v37 — 2026-08-14. The attachment, from the officer's end: the file link opens a PAGE instead of
// answering with bytes, and a dispatch now waits for the upload it would otherwise overtake.
// `main.ts`, `compose.ts` and `dispatch.ts` all moved, so the digest moved with them.
//
// NOT folded into v36, and the note above says why the exception does not apply: v36 IS deployed
// — `f781817`, verified on the public domain — so handsets are holding it, and re-recording the
// digest against it would leave every one of them on the old bundles for ever.
//
// NOT folded into v36, and the note above says why the exception does not apply: v36 IS deployed
// — `f781817`, verified on the public domain — so handsets are holding it, and re-recording the
// digest against it would leave every one of them on the old bundles for ever.
// v38 — 2026-08-14. Dashboard liveness, phase 1: ages that count up on their own between polls,
// and the heartbeat and poll ring in the header. `index.html`, `dashboard.ts` and `main.ts` moved.
//
// NOT folded into v37, even though v37 has not been deployed either — and the difference from
// v35's note is worth keeping. v35 was uncommitted work on one laptop, so "nothing has ever
// served it" was a fact about the whole world. v37 is its own commit and can be deployed on its
// own; fold this into it and a district that shipped v37 first would keep the attachment-only
// shell for ever. **Once a version is committed separately, it is no longer safe to fold into.**
// v39 — 2026-08-14. Dashboard liveness, phase 2: the panels are reconciled by key instead of
// wiped and rebuilt, so the row whose meaning changed is the one thing that flashes. v38 is
// DEPLOYED, so folding into it was never an option — see its own note for the rule.
// v40 — 2026-08-14. Dashboard liveness, phase 3: a counter that changed SLIDES to its new value.
// Deliberately not a numeric tween — see `slideNumber` for why counting would put numbers on the
// screen that were never true. v39 is DEPLOYED, so folding into it was not an option.
// v41 — 2026-08-14. Dashboard liveness, phase 4: the dashboard listens to `/board/live` too, with
// a 3s coalescing debounce. `/board/live` is already in NEVER_CACHE (M8) and must stay there — a
// cached SSE stream never resolves and hangs the connection silently. v40 is DEPLOYED.
// v42 — 2026-08-14. Dashboard liveness, phase 5: the activity feed reconciles and a genuinely new
// row slides in (never on the first paint); the ticker deals its facts into frames and rotates.
// v41 is DEPLOYED.
// v43 — 2026-08-14. Dashboard liveness, phase 6: a freshness hairline on the weather and news
// panels — the only two whose age is a fact about the panel rather than a row inside it. It
// drains against the same threshold their age text turns amber at. v42 is DEPLOYED.
// v44 — 2026-08-14. Dashboard liveness, phase 7 (last): sparklines on the five district counters.
// Zero-based, absolutely positioned so no tile grows, and each series is the replayed history of
// the number above it — `district.trend`, the only server change in the seven. v43 is DEPLOYED.
// v46 — 2026-08-15. Card depth, phase 1 of 4: `web/src/tilt.ts` arrives, and `dashboard.ts` takes
// `reducedMotion` from it instead of declaring its own copy. **Nothing on any screen changes** —
// no element carries a `.tilt` class yet — but the shell's bytes do, because `app.js` now bundles
// a module it did not before. A shell whose bytes moved under an unchanged version string is the
// 2026-08-04 fault exactly. v45 is its own commit (`8b884bd`), so folding into it was never an
// option — see v38's note for the rule.
// v47 — 2026-08-15. Card depth, phase 2 of 4: the card's CSS lands in `index.html`, and **still
// nothing draws it** — no element carries `.tilt` until phase 3 builds one. Two fixes travel with
// it, both discovered by reading rather than by anything going red. `overflow: hidden` moved off
// `.panel` and onto the two panels that ever needed it (weather and news, the only two carrying a
// freshness hairline) — on every other panel it was inert right up until a tilted card wanted to
// leave its own box, and it would have sliced the corner off every lifted tile. And `.face`
// declares `background-color` AFTER its gradient, because the shorthand resets it to transparent
// and `contrast.mjs` reports a gradient as unmeasured — without that line the district's counters
// would have dropped out of the contrast pass while it stayed green. v46 is DEPLOYED.
// v48 — 2026-08-15. Card depth, phases 3 and 4 of 4, and they had to ship together: the counters
// become cards, and `signatureOf` learns to ignore what a pointer did to one. Without the second
// half the first is a dashboard that replaces the tile somebody is hovering, every twenty seconds,
// silently. The sparkline moved INTO FLOW at the owner's decision — 23px a tile measured, 7px on
// the page at 1920x1080, spent so the line is readable at four metres instead of a 40px smudge in
// a corner. `.key`'s painted rules moved onto `.key .face`; every descendant rule was left alone.
// v47 is DEPLOYED.
// v49 — 2026-08-15. Card depth, phase 5: a panel becomes the same material as a counter — a
// light from the top left, a layered shadow, a lit top edge. **Deliberately not the card's
// motion.** A counter is one large number and parallax has something to say about it; a panel is
// five text rows and turning one skews a list. The deciding reason is neither: `web/src/status.ts`
// builds `.panel` sections too, so moving what paints onto a `.face` would have left every panel
// on the STATUS screen with no ground, no border and no padding — silently, in a different
// bundle. One rule, both screens. Weather and news are excluded: they carry `background: none`
// because what is on them came from outside the district, and a lit raised surface says the
// opposite. v48 is DEPLOYED.
// v50 — 2026-08-15. Card depth, phase 6: a panel gets the MOTION as well as the material, on both
// screens. `upgradePanel` in `tilt.ts` turns a plain `.panel` into a card in place — one
// description of the card that `index.html`'s fifteen sections and `status.ts`'s JS-built ones
// both run, rather than six elements typed fifteen times in one place and constructed in another.
// ⚠️ It is ADDITIVE: `.panel` still paints on its own and the card's rules hang off `.panel.tilt`,
// which exists only once the upgrade has run — so a panel this never reaches is the panel it was
// yesterday, instead of one with no ground, no border and no padding. Weather and news opt out
// with `data-flat`: what is on them came from outside the district, and a lit raised surface says
// the opposite. `.panel > h2` became `.panel h2`, because the heading is no longer a direct child.
// v49 is DEPLOYED.
// v51 — 2026-08-16. M10-28…32: which WhatsApp template a message goes on is decided PER MESSAGE,
// and the compose screen says what will happen to a file. The shell change is only that sentence
// — *"A photo can ride the message. A PDF travels as a link."* — but it is a shell change, and a
// shell whose bytes move under an unchanged version string is the 2026-08-04 fault. v50 is
// DEPLOYED.
// v52 — 2026-08-16. M10-36: **"Post" becomes "Designation" on every screen the district reads.**
// The district's own word, and it is only ever the word — `seat`, `seatId`, `/roster/posts/…` and
// every event payload are untouched, because renaming an identifier to match a label is how a
// record stops being readable against its own history. The guide keeps both: its glossary now says
// *Designation*, and says plainly that older screens and the record itself call it a post or a
// seat. v51 is DEPLOYED.
// v53 — 2026-08-16. M10-35: both add-an-officer forms say when a name or a number is already
// there. ⚠️ **A warning, never a refusal, and the district is the reason** — two officers in Bajaur
// genuinely share `03000000171` (Q-19, migration 0006, confirmed in the live directory), so a form
// that refused a repeated number could not enter the district's own roster. Amber, never red: red
// reads as a refusal on a control that does not refuse. The picker checks the whole district; the
// roster can only see its own department and its wording says so, because a sentence implying it
// had checked the district would be worse than no warning. v52 is DEPLOYED.
// v55 — 2026-08-16. Ambient life, phase 1: **the screen is never still, and nothing on it moves.**
// Every animation before this one fires because something CHANGED — `.flash`, `rollup`,
// `rowArrived`, the heartbeat ring — which is right, and is why a wall screen that goes twenty
// quiet minutes without one figure moving is indistinguishable from a screen that has crashed.
// A light now crosses every card and every panel on a nine-second cycle, staggered so the deck
// ripples instead of blinking, and a counter's number breathes inside an aura whose TEMPO carries
// its tone — 2.2s on an alarm tile, 5.4s on a calm one. ⚠️ **No figure is ever touched.** Ambient
// motion may light a number or breathe behind it; it may never change what it says, and it may
// never render a value that was not the value — the idle-case half of the rule `slideNumber`
// settled for the change case. It is CSS and pseudo-elements ONLY, and that is load-bearing
// rather than tidy: anything writing a class or a style would make every card differ from its own
// rebuild, and `reconcile` would replace and re-roll the counters every twenty seconds over no
// news at all. Reaches the Status screen for free, through `upgradePanel`. v54 is DEPLOYED.
// v57 — 2026-08-16. ⚠️ **The note above shipped without the code it describes, and this is that
// code.** v55 bumped the version and wrote the paragraph; the CSS block in `index.html` that
// actually draws any of it was left uncommitted, and two agents were working this tree at the
// time. v56 then went out — M10 Phase B, DEPLOYED — carrying a shell recorded against an
// `index.html` with no ambient rules in it at all. So the district has the paragraph and none of
// the light. Nothing here is new work: it is v55's block, unchanged, finally in a commit, plus
// this note so the gap is legible in the one file that records what each shell contained.
// **The lesson is the version string, not the CSS.** A `CACHE` bump asserts *the shell changed*.
// Bumping it in the same breath as writing the change, but in a different file, means the
// assertion can ship on its own — which is the 2026-08-04 fault wearing different clothes.
// v56 is DEPLOYED.
// v59 — 2026-08-17. M10 Phase D: routine and important. `situation` is replaced in the default
// layout by two new panels — `importantEmergencies` and `routineEmergencies` — and `#whatBlock`
// gains a static `#importance` control beside `#kind`. `situation` itself is untouched in the
// registry and stays fully choosable; only the shipped default moved.
// v73 — 2026-08-18. M11-34: **the dashboard leaves the shell.** `app.js` drops 21,902 bytes —
// all of `dashboard.ts` bar the running clock, and the whole of `tilt.ts`, which nothing else in
// the shell imported. The shell goes from **162,040 to 140,198** of its 163,840, which is what
// makes the rest of Phase A buildable: it had 1,800 bytes left, and a faceted panel does not fit
// in 1,800 bytes. The budget was not the thing that moved.
//
// `/dashboard.js` is NOT in `SHELL` and must not be: it is held by the generic handler under
// this version string, exactly as `office.js` and `help.js` are. It reaches the cache anyway,
// early, because sign-in prefetches it — which is also what keeps a screen somebody *lands* on
// off the wrong side of this project's own lazy-loading rule.
// v74 — 2026-08-18. **The departments panel could not open the board for anything two
// departments answer for.** `incidentRow.ts` wrote `data-departments` with `join('')` while
// `main.ts` matched it with `split('')`. One department round-trips through that mismatch
// unharmed, which is why every test and every screen looked right; two fuse into
// `"Rescue 1122Police"` and match neither name, so the panel said *3 open* and the board it
// opened said *nothing matches*. A shell fix, so a version string, so this line.
// v75 - 2026-08-18. **M11-16: the faceted panel.** The board can be narrowed by severity,
// stage, kind and department, and every count is folded by `buildBoard` from the very rows it
// sends. Each facet carries the `data-` attribute the same fold wrote onto the row, the value,
// and how to compare it - so the browser holds no predicate of its own and a facet reading 4
// lands on 4 rows by construction. Shell 140,198 -> 144,295 of 163,840.
// v76 - 2026-08-18. **M11-17: saved views in the URL.** The board writes what is on screen into
// the hash - the narrowing, the order, the density - and a pasted link restores it and lands on
// the board. A #board link selecting a screen is what makes the rest reachable at all.
// (INV-05) A saved view is presentation and never authority. Everything it restores is applied
// to rows the server already scoped and sent, so a link narrows and can never widen: a facet is
// only applied if the board's own payload offered it, and ?sort= is validated server-side, so a
// crafted order becomes a 400 rather than a board.
// v82 - 2026-08-18. **M11-22: the report's figures open their own rows.** Nothing in the shell
// changed; `reports.js` and `reports.css` did, and `shellDigest()` hashes everything the build
// emits - so the lazy bundles are held under this string and a browser that already has the app
// keeps the old ones until it moves. `shellVersion.test.ts` is what said so, on a run where the
// only edits were a server fold and a lazy screen.
// v84 - 2026-08-18. **Phase C: the wall fits one screen.** `condition` comes off the shipped
// default - it sat at `top: 1068` on a 1080 screen, twelve pixels of a 252-pixel panel above the
// fold, so nobody has ever seen it - and two layout wastes go with it: `main`'s bottom padding,
// which the wall does not need because the ticker is sticky, and one step off `#dashScope`'s top
// margin. 1385 -> 1080 exactly. A shell change, so a version string, so this line.
// v85 - 2026-08-19. **The console stops repeating itself, and its chips say how much they
// narrow.** Found by rendering the Administration screen against a district-sized directory
// rather than the three departments a test creates: the "no routing signals — the control room
// can still choose them" sentence was on **154 of 159 cards**, two lines each, pushing every
// card's own controls down for information that is already in the sweep at the top of the tab.
// The card keeps the fact (`no routing signal`) and the sweep keeps the explanation. And every
// filter chip now carries its own count, because four of the five match nearly everything this
// district has — `no routing signal 155` says, before it is clicked, that it narrows nothing.
// v97 - 2026-08-19. **The Deadlines screen is the exceptions, and 'clear it to go back'
// finally does something.** It drew a row for every department - 79 rows of five severities,
// close to 400 numeric boxes, of which a handful ever held a decision - on the one screen
// whose purpose is to show what the district has DECIDED. Now: the district's five figures,
// then only the departments holding one of their own, and a picker for the next. Measured
// against the live directory it went from ~795 boxes to 5. And the box that has said since
// M1a that emptying it gives the figure back now does, asking why - which the config log
// requires and the browser never collected.
// dnc-shell-v101 - 2026-08-19. **The district's performance is drawn once, in the Record.** The console
// drew it from /admin/performance and the Record draws the same figures from the same fold,
// with the same medians and the same dash-never-a-zero - two doors onto one calculation, which
// is how two screens come to disagree about a district in front of the people who run it. The
// renderer, its num() helper and its stylesheet rules went with the tab; a signpost is left
// where the tab stood, because a door that simply vanishes reads as something lost.
// dnc-shell-v111 - 2026-08-21. **Routing is gone from the console and the picker (ADR-0022).**
// The signal editor, the "Add signal" form, the per-card `no routing signal` tag, the facet chip
// that answered 154 of 159, and the department ordering built on it are all off the screen; the
// Dashboard's per-department aside now says `Console` and lands on the card. **The bump matters
// more than usual here**: v110 is already in the field, so without it every handset that has
// opened the app would go on serving a console with controls behind them that configure nothing.
// dnc-shell-v112 - 2026-08-21. **The control room can act on an incident from the incident.**
// Phase 8c: `#takeAction` on the detail screen - follow up (8b) . escalate by a person's hand
// (8c) . mark resolved . close. **This is the only part of phases 8a-8c a district can see**:
// 8a deleted the escalation's message at the district's request and 8b built the chase, and
// neither had a button, so the room could watch an emergency go unanswered with nothing to do
// about it. The panel's markup, every confirmation and all four calls live in `dispatch.js`, not
// here - the shell moved 160,498 -> 160,937 of 163,840 for a container and one `hidden` toggle.
// **The bump is what delivers `dispatch.css`**, which is held under this string by the generic
// handler and is where the new panel's styling is; without it a control room that has opened the
// app gets four unstyled buttons.
// dnc-shell-v113 - 2026-08-22. **Follow up goes in ONE press.** The owner used the panel and
// asked for it: two dialogs stood between the room and the only button on that screen which
// reaches a person, and the second asked for words whose honest answer is almost always *the
// usual ones*. The saved wording is the server's and always was - `api/followUp.ts` is the only
// place that knows the emergency, which of Meta's two paths the handset is on, and which stages
// go on the buttons. The other three keep their confirmations: they each write a fact the board
// is read from, while a stray chase reaches nobody new and is undone by being ignored.
// **The bump is what delivers the new `dispatch.js`**, which is held under this string by the
// generic handler; without it a control room that has opened the app keeps being asked twice.
// dnc-shell-v114 - 2026-08-22. **The picker became a contact list** (ADR-0023). Counted off
// Bajaur's own directory: 79 departments + 81 posts + 40 people = **200 selectable rows for 40
// real handsets**, one officer drawn three times, under 79 headings whose names restated the
// designation below them. It is one flat list now, one row per officer, carrying the name, the
// designation and the number.
// **The bump is what delivers the new `dispatch.js`**, and here it is not a nicety: an older
// shell against this server draws a picker whose department and person rows the server no
// longer sends - so *"Tell all 8"* would count officers that are not there, and the
// add-an-officer form would offer an empty department select. Two halves of one screen
// disagreeing about who exists is exactly what this file's v9 warning is about.

// dnc-shell-v115 - 2026-08-22. **The shift screen is retired** (O-44, the owner's decision).
// M1-01's whole claim was a department's duty officer working one emergency from one screen.
// ADR-0024 took the writing half away and left a window nobody could touch anything through -
// and it had never had a user: Bajaur holds ONE account, `AC HQ Bajaur`, the control room.
// **The bump is what removes it.** Without it an officer who has opened the app keeps a cached
// shell carrying the "My shift" button and the section behind it - a tab that reaches a screen
// this server no longer serves, which is worse than the screen was.
// dnc-shell-v118 - 2026-08-23. **The things that do not finish at midnight** are on the wall:
// one panel, five named lanes - Security, Flood, Alert & Advisory, Meetings, Information - and
// `activity` comes off the default layout to make room (ADR-0015: still registered, not deleted).
// `index.html` gained the panel and its rules, `dashboard.ts` draws it, `main.ts` gained the
// "who is coming" checkbox and `compose.ts` the review date.
// **The bump is what delivers all four**, and it is v118 rather than v116 for a reason worth
// keeping: **v115 was taken twice** - once above for the shift screen, once on the branch this
// merges - by two pieces of work that did not know about each other. The one that commits
// second takes the next free number, which is this file's own rule about a version that has
// already left the laptop. Reusing it would have left an officer's cached shell answering to a
// string that means two different shells.
// dnc-shell-v119 - 2026-08-23. **The Record opens on the queue.** The day picker, the From/To
// range and "N withdrawn today" moved from above the rows to a `#boardPeriod` section below
// them, and arriving from the Dashboard now lands on the emergency rather than at the top of
// the screen. `index.html` moved four blocks and folded the new section into the rule
// `#boardReports` already had; `main.ts` gained `landOnFiltered`.
// **The bump is what delivers the new layout.** Without it a handset that has opened the app
// keeps a shell whose Record still stacks three date controls above the queue, against a
// `main.ts` that no longer expects them there.

// dnc-shell-v120 - 2026-08-23. **The Status screen stopped configuring what it reports.** The
// two selects an office saw under every service - which department answers for it, and how long
// its report stays believable - are gone, and `office.css` lost the rules that drew them.
// The bump is the ordinary one this file exists to enforce: `office.css` is in the shell, so a
// handset holding an older shell would go on drawing two selects against a build that no longer
// makes them - and the assign select's only remaining option would be "nobody assigned".
// **This work has now asked for v116, v119 and v120**, which is the note above about v115 being
// taken twice, happening again while this branch waited: it was written against v115 on another
// line, and two other shells shipped before it landed. The one that lands last takes the next
// free number. Nothing here needs the number to be contiguous, only unused.
// dnc-shell-v121 - 2026-08-23. **Still running rows open the incident.** Each row on the panel
// now leads to that incident on the board, where Resolve and Close actually live - the wall
// reports and still closes nothing. `index.html` gained `.srow.go` beside the two selectors
// that already carried the affordance, and `main.ts` gained `onOpenIncident`.
// **The bump is what delivers the door.** Without it a handset holding an older shell draws
// rows with no tab stop and no cursor against a `dashboard.js` that expects both, so the panel
// would look identical and simply not open - the worst shape of stale shell, because nothing
// about it says it is stale.
// **v119 was taken while this was being written**, by the Record's queue layout on another
// line - the third time on this branch after v115 and v116. Whoever lands last takes the next
// free number; contiguity is not the property that matters, being unused is.
// dnc-shell-v122 - 2026-08-23. **The Status screen's rows stopped being dealt into another
// panel's columns.** `.srow` belonged to the Status screen from 2026-08-14; the "still running"
// panel took the same name on 2026-08-22 with `grid-template-columns: 5.2rem 1fr auto`, in
// `index.html`'s inline block. `office.css` loads later and won every property it declared - but
// it never declared `grid-template-columns`, and a rule cannot reset what it does not mention.
// So a service name wrapped inside 5.2rem, the note shrank to a stub nobody could type into and
// the age fell below the buttons. Reported from a phone, which is where it read worst.
// The Status screen's rows are `.sreport` now. **The bump is what delivers both halves**: the
// class in `office.js` and the rules in `office.css` are no use to each other one version apart.

// dnc-shell-v124 - 2026-08-23. **The row names who was told, and says how it ended.** The `who`
// column printed "told directly" for every emergency dispatched to a named officer - the
// ordinary case since M10-07/08/09 - so it named nobody on the screen the district reads at
// 02:00. It now carries the names, `+N` opens the rest in place, and a resolved row shows the
// officer's own words. `index.html` gained the four rules those need; `incidentRow.ts` draws
// them; `board.ts` sends `toldNames` and `resolution`.
// **The bump is what delivers the rules.** Without it a handset holding v123 draws the new
// `+N` button and the resolution line against a stylesheet that has nothing to say about
// either - an unstyled bare button in the middle of forty rows.
// dnc-shell-v126 - 2026-08-23. **What we sent is on the row** (ADR-0026). The text of an outbound
// message was recorded nowhere: `notified` is appended before the send, and `whatsapp_message`
// stores no body and is documented as not being history. A new `message_sent` event carries the
// two fields an officer actually reads - `what` and `where` - and `board.ts` sends the latest one
// as `sentMessage`. The row puts it behind the same disclosure as the recipient list, so one
// button opens everything extra instead of two sitting side by side in forty rows.
// **The bump is what delivers the rules and the renderer together.** A handset holding v125 would
// draw the new `message` button and the `We sent:` line against a stylesheet that has nothing to
// say about either, and `.rowmore > span` is what stops the two sentences running together.
// ⚠️ **Absence is UNKNOWN, not silence.** Nothing sent before today has one and none can be
// rebuilt - the composer runs off current state, so an old message rebuilt now is a sentence that
// was never sent wherever the incident has since been corrected.
// dnc-shell-v127 - 2026-08-23. **A follow-up that could not be sent stops hiding.** `followed_up`
// prints its own type as the timeline heading, and that word is the same whether Meta took the
// message or refused it - and `detailOf` had no case for it, so the screen showed *followed up*,
// a name, and nothing else: not the note, not which alert was chased, not that it never left the
// building. The post-incident report has said "Follow-up could not be sent" since the feature
// shipped, so the printed document and the screen disagreed about the same act.
// The fold now carries `followUps`, `board.ts` sends `followUp`, and a chase that failed is a
// full-width `.flag unmet` on the row rather than something behind a button - INV-03 asks for a
// failure to be visible where somebody acts on it, and nobody presses a disclosure on forty rows
// to find the one with a dead number in it.
// **The bump is what delivers the two new rules** - `.tl[data-failed]` and `.rowchase` - with the
// renderer that sets them.
// dnc-shell-v129 - 2026-08-24. **What we sent comes out from behind the button, and the row says
// how many were told.** The district asked twice for the same thing, which is the answer: *"msg
// mein kya tha"* is not a detail somebody goes looking for, it is what the row is about. So
// `.rowsaid` is drawn IN PLACE, full width, on every row somebody was told about - and it says
// **not recorded** rather than nothing when the words are not in the log, because absence means
// UNKNOWN and never "nothing was sent" (ADR-0026).
// The `who` column stopped answering *how many*. A row reading **"Information Technology"** could
// not tell the district whether the alert had gone to one officer or fourteen, and the `+N` it
// drew in the other case named one recipient out of three - which reads as though that officer
// holds the incident. The count carries it now, in the district's own words: *"just number ho"*.
// **The bump delivers `.rowsaid` as a grid child, `.rowsaid.none`, and the counter's own label**
// with the renderer that writes them.
// dnc-shell-v130 - 2026-08-24. **The intake box is called *Incident details*.** The label read
// *"What did the caller say?"* - the operator's own phrasing turned into a field name, and odd on a
// screen that is otherwise plain. It also narrowed the box to telephone calls when the same field
// takes a walk-in, a wireless message or the operator's own note. **Incident details** is the term
// the service already uses, and it matches the record: the value goes out as `description`. The
// help screen's mockup and its explanation move with it so the two screens do not disagree.
// **The bump is what delivers it** - `index.html` is precached in `SHELL`, so without it every
// handset that has opened the app keeps reading the old label for ever.
// dnc-shell-v132 - 2026-08-24. **The district has its own number for an emergency: DNC-BAJAUR-42.**
// The detail screen's identity line was the uuid - *"Incident 297e3fba-accf-4298-808a-c3c4d01d3337"*
// - which is the right identity for the software and unusable by the control room that reads it
// out on a telephone. Every incident now also carries a number the district counts from 1, on the
// detail screen, on every row of the Record, on the printed report and in the export, and typing
// it into search finds it. The uuid is not hidden: it is the URL, and it is on the report as
// **record id**. **The bump delivers `.ref` in the row's `What` cell and the renderer that draws
// it** - without it a handset that has opened the app draws the number nowhere.
// dnc-shell-v133 - 2026-08-24. **The report screen's tiles stop being words in boxes.**
// Every category and every severity now carries an icon above its word, and severity wears its
// own colour at rest and fills with it when chosen - before this, three of the four levels filled
// violet, so a *low* report and a *critical* one looked identical until you read them. The word
// stays under every icon (INV-04) and no icon carries a title, which is what keeps the critical
// tile's text exactly "Critical" for the test that guards it. **The bump is what delivers it** -
// all of it is markup and CSS inside `index.html`, which is precached in `SHELL`, so without a
// bump every handset that has ever opened the app keeps the old screen for ever.
// dnc-shell-v134 - 2026-08-24. **One grid holds what happened AND what kind of message it is.**
// The district asked for their eleven tiles in a single list; the owner chose it knowing the cost
// written down in `backlog/five-categories-questions.md`, and attached one condition - the
// WhatsApp flow does not change. So a tile writes BOTH `category` and `kind`, in the pairs the
// two old controls already produced, and the kind select is hidden rather than removed. Thirteen
// tiles, not eleven: `order` and `schedule` are not on the mock-up and dropping them would have
// removed two things the app can do. Six of the thirteen are message kinds and are shown to the
// control room alone. *Where is it?* and *Anything else?* move ABOVE the after-panel and BELOW
// the button, so what is typed rides the `reported` event without pushing the button down a
// handset screen. **The bump delivers all of it** - markup and CSS inside the precached
// `index.html`, plus `main.ts`, which the shell also holds.
// dnc-shell-v142 - 2026-08-25. **The stylesheet is minified and the category icons are in
// colour.** Deployed onto this box rather than by moving the checkout to a branch: three
// commits here exist on no remote, and taking the checkout to origin would have removed that
// work from the running system. So only what this change actually touches came across -
// `build.mjs` and `index.html`, byte-exact out of origin b3da7f4 and 3cbb53e - and nothing
// else on this box was altered. No server code, no migration.
//
// **v142 and NOT v141, which is the number the same work carries on origin.** This shell is
// not origin's: `dashboard.ts`, `dispatch.ts` and `reports.ts` differ here. Reusing 141 would
// put two different sets of bytes under one cache key, which is the exact fault the version
// string exists to prevent. **Origin must bump to 143 or higher next.**
// dnc-shell-v144 - 2026-08-25. **The icons become solid, and the word wears the colour too.**
// v141 gave them their hues and the owner said the colours had arrived and still looked wrong.
// They were right: those were 1.9px OUTLINES, and a hairline carries almost none of its own hue.
// Filled shapes at 34px, with the word beneath each in the same colour and set in capitals -
// the mock-up shape, and thirteen tiles is a grid somebody scans rather than reads.
//
// **v144, and v143 is the reason.** This branch and m6-control-room each reached v143
// independently, carrying DIFFERENT bytes under one key - the exact fault a version string
// exists to prevent. Skipping to 144 is how that is settled without either side rewriting a
// number a handset may already hold.
//
// Two faults this turned up, both CSS specificity and neither visible in a screenshot of the
// resting state: a SELECTED Fire tile kept the word red on a violet fill (1.08:1, caught by
// contrast.e2e), and a selected severity tile drew its icon in the colour it had just been
// filled with - an icon you cannot see, which no contrast test can catch because an icon
// carries no text.
// dnc-shell-v150 - 2026-08-26. **The Record says what it is showing, and the deck is two groups.**
// Eleven bands above the queue became three: one scope bar carrying the period in the largest
// type on the screen, the staleness clock, the withdrawn line and a two-button Still open / A day
// control. Find is a DOOR now rather than a form standing open all shift, and the stage chip
// stops printing over the name beside it - a flat track that could not grow, only ever visible
// with the detail pane open.
//
// **v150, and the detail pane is NOT this branch's.** v149 redesigned that pane the compact way
// and is live; this work had redesigned it the other way, and the owner settled it in favour of
// v149. The pane here is untouched. These are shell bytes, so an already-open control-room
// handset needs the fresh key to receive any of it.
//
// dnc-shell-v149 - 2026-08-26. **Record detail now opens on the current situation.** Severity,
// responsible team and response are first; audit detail is one press away. Report, correction,
// withdrawal and restore controls are unchanged. These are cacheable shell bytes, so the fresh
// key is required for an already-open control-room handset to receive the compact view.
// dnc-shell-v152 - 2026-08-27. **The dashboard's panels stop tilting, and the text the
// parallax was pushing outside its own tile comes back inside it.** Owner's request, three parts:
//
// - A panel is a card that does NOT move. `makeCard` still runs on every panel - the ground,
//   the border, the padding and the light all hang off `.panel.tilt` - but a dashboard panel
//   now carries `.still`, which `tilt.ts` excludes from the pointer's reach entirely: no
//   `--tilt-*` written, never `live`, never `press`. The rows inside it and the District
//   counters keep everything they had. That scope is the owner's own, stated twice.
// - The four `translateZ` depths are switched off inside every panel except `keys` and
//   `situation`. A perspective projection SCALES a lifted element away from the card's centre,
//   and on a ~500px row card z3 moved a name 16px past its own 9.6px of padding - every row
//   name on Services, Utilities and Officers was rendering OUTSIDE its own border, and an
//   activity headline was sliding left over its own clock.
// - A panel's name outranks the figure beside it. `.age` is `--t2` and `.panel h2` is
//   `--t1`, so on nine panels at once the count rendered one step LARGER than the panel's own
//   name; the name goes to `--ink` and the figure out of capitals.
//
// 🔴 **v152, BECAUSE v150 AND v151 WERE BOTH TAKEN BEFORE THIS COULD LAND — TWICE IN ONE DAY.**
// This work bumped v149 -> v150 on `reconcile-m6`. By the time it was cherry-picked onto the
// deployable line, that line had independently spent v150 on the Record's scope bar; renumbering
// to v151 collided in turn with `adr-0030-on-live` (commit 3382661, digest 6535e957...), which
// had recorded v151 for the ADR-0030 fixture sweep. Three branches, all forked from the same
// production HEAD 309b29a, each reaching for the next free number without seeing the others.
//
// **Every one of those was two different shells under one cache key** - the exact fault the
// version string exists to prevent, and now the fourth and fifth time this repository has hit it
// (see v142 and v144 above). The v150 clash was caught only because the cherry-pick happened to
// conflict in this file; the v151 clash was caught only because another session said so. Nothing
// in the suite looks for it, and `shellVersion` cannot see it - it checks that the digest
// matches the bytes on THIS branch, which is exactly as true for a duplicated key as a unique
// one. ⚠️ **Before bumping, read the number off every branch, not off this file:**
// `git log --all -p -- app/web/shell-version.json | grep '"cache"'`.
//
// **The digest below measures the shell on THIS branch.** The one recorded on `reconcile-m6`
// measures a different shell and does not travel with the commit.
// dnc-shell-v151 - 2026-08-27. **The screens stop naming a department** - ADR-0030, the client
// half of migration 0039. The console’s Departments tab is a *Setup check*, the picker’s search
// stopped offering to search departments, and the roster draws one flat district list.
//
// **v151, and v146 is the number this work originally took.** That was recorded against a
// PARALLEL line of the Record redesign which the owner has since settled against - v149’s
// compact detail pane is live and v150 carries it, so shipping v146 would have rolled the
// district BACK to a pane they rejected and dropped `boardTruncated` with it. The ADR-0030 work
// was rebased onto the live line instead and takes the next free number, which is this file’s
// own standing rule: whoever lands second takes the next number, and the numbers need only be
// unused, never contiguous.
// dnc-shell-v153 - 2026-08-27. **The console's Rosters tab was unreachable and nothing said so.**
// It filled a `<select>` from `GET /admin/departments`, which answers an empty list since
// migration 0039, and only drew a roster once that select had a value - so the one screen the
// control room maintains its own contacts on rendered a blank dropdown and nothing else, with no
// error anywhere, because every request succeeded. There is one roster and it is the district's,
// so it is shown directly. `#rosterPanel` keeps its id and `mountRoster` is untouched.
//
// **v153, not v152.** `deploy/panel-tilt-off` took v152 for the dashboard panel work and is
// deployed; the numbers need only be unused, never contiguous.
//
// **v153 carries v152 as well.** `deploy/panel-tilt-off` is production HEAD (`c1c3a20`), so
// this branch merged it rather than deploying over it — shipping ADR-0030 alone would have
// rolled the dashboard’s panels back to the tilt the owner asked to have removed. The digest
// below measures the shell with BOTH in it.
//
// v158: Move 7 KPI metrics strip into Left Sidebar.
// v159: connection-status hardening so a browser with site data blocked or a wedged
// `dnc-bajaur-outbox` IndexedDB no longer sits stuck on "Checking connection…" after a clean
// sign-in. `deviceId()` wraps its `localStorage` read in try/catch — an unguarded read
// THROWS and killed `boot()` before the intake form was wired (INV-01); `loadIdentity()`
// marks the link reachable on a 200 from `/auth/me`, the earliest completed round-trip;
// `trySync()` swallows an IndexedDB throw and still repaints instead of freezing
// `reachability` at `'unknown'`; and `void boot()` gained a `.catch()` that replaces the
// status line with an actionable message. `web/src/main.ts` only.
//
// v160: the actual live cause of "Checking connection…" — the Command Center Record
// redesign rebuilt this screen's markup and deleted `#boardUnassigned`, `#boardFilter`,
// `#boardFilterText`, `#boardFilterClear` and `#boardTruncated`, but `main.ts` still wired
// them unconditionally in `boot()`. `el('boardFilterClear').addEventListener(...)` threw
// on EVERY load, online and offline, so `boot()` never reached `void trySync()` or the
// sign-in form handler — the app was broken in production. All five elements are restored
// to `web/index.html`, `hidden`, exactly where the wiring expects them; they change
// nothing on screen until their own code paths run. `web/index.html` only.
//
// v161: the redesign's selector drift, fixed where it changed live behaviour. Four board
// regressions, all `web/index.html`: (1) `#boardSortReset` — the way back to the queue's own
// order — was trapped inside a `hidden` parent span in `#boardHead`; it moves to the board's
// view-tools bar, which also restores `#boardHead` to exactly seven grid cells. (2) the
// acknowledged-recede and overdue-ground rules were outranked by `#boardTable .row` at desk
// width, so every row read white whatever its state — re-added at that width. (3) `#boardHead`
// regained the 4px transparent left edge every row carries, so column headings sit over their
// cells again. (4) `#boardSummary` stacks single-column in the left sidebar rather than
// wrapping to four ragged rows. `board.e2e` test 16's expectation moved to the sidebar layout.
//
// v162: the control-room intake is a two-column form at desk width (2026-08-31). `#reportView`'s
// intake goes two-column for an administrative seat on a screen >= 90rem — what happened + how
// serious on the left, incident details / urgency / attachment / place on the right — in the
// administration console's own colours (`--card` panels on a `--line` hairline, `--slate` capital
// section labels, `--primary` step numbers, `--r4`, `--lift`). UI only, `web/index.html` only: two
// `<div class="rcol">` wrappers went into `#report` and every new rule is behind
// `@media (min-width: 90rem)` AND `#reportView:has(#whatBlock:not([hidden]))`, so a handset, a
// signed-out phone and a control-room laptop under 90rem render EXACTLY today's single column —
// the two-tap critical path (M0-36) never enters this branch. No endpoint, `id`, `data-*`,
// capability or wiring moved; `#submit` keeps its red `--critical-fill` and kind-dependent wording.
//
// v163: the two-column intake is re-proportioned (2026-08-31). The owner read v162 live and
// called it "ajeeb": the left *what happened* column was a fixed 21rem while a near-empty
// *incident details* card stopped short on the right, leaving an asymmetric void. Now the left
// column is the WIDER of the two (`minmax(0, 1fr) 26rem`, max-width 70rem), the right card
// `align-self: stretch`es to the row and its textarea grows to fill it — a control room
// transcribing a call wants the room to write — and `#submit` + the two optional trailing
// fields sit in a `.rcolwide` band spanning both columns rather than hanging off one. Still UI
// only, `web/index.html` only, still entirely behind the `@media (min-width: 90rem)` +
// `#reportView:has(#whatBlock:not([hidden]))` guard: no element is reordered and nothing is
// renumbered, so the handset / signed-out / field layout is byte-identical.
//
// v165: the intake form's text is bolder (2026-08-31). The owner read v163 live and said the
// text was not clear. Four weight bumps, `web/index.html` only, no colour and no size moved:
// the section legends `--w2` -> `--w3`, the category tile words `--w2` -> `--w3`, every tile
// word (severity + urgency included) `--w1` -> `--w2`, and the field labels ("Where is it?" /
// "Anything else?") `--w1` -> `--w2`. All three `<legend>` elements are the intake form's own,
// so the legend rule is effectively scoped. No structural change; narrow / desk both benefit.
//
// v166: the Record row carries the officers' own answers — client half (2026-08-31). The
// server half (`BoardRow.response`, b3e0e91) has been live and inert; this renders it. (Built
// as v164 off 4b827b9, rebased over v165 and renumbered.) `incidentRow.ts`: the "State"
// column is "Response" — a single recipient's reply verbatim, a tally (`2 responded · 1
// waiting`) for a dispatch to many with each recipient's words in the row's disclosure,
// RX-02's reassign line unchanged and still first, and the stage sentence still when nobody
// was told. The "Action" column is contextual: "no action needed" on a resolved row, a
// **Follow up** button when `response.silent > 0` (`main.ts` confirms once, then POSTs
// `/incidents/:id/follow-up`), "Inspect →" otherwise. `index.html`: the seven-track board
// grid is re-proportioned with a wider gutter (the district said the columns ran together).
// Board + search share `incidentRow.ts`, so both surfaces move together.
//
// v167: the Record's left-sidebar facet panel is a vertical menu again (2026-08-31). The
// district asked for the earlier look back — the Command Center redesign's `.sidebar-item`
// styling (full-width rows, label left, count right, a quiet `--card2` hover) read well and
// only its function was wrong; v161 fixed the function (every severity, stage and kind, from
// `data.facets`) and left plain wrapping chips. This is CSS only — `.fgroup`/`.facet` in
// `index.html`, no markup and no `renderFacets` change — so the restored function is untouched.
//
// v191: a recipient group has a profile picture (2026-09-01). The upload/preview/Remove
// control lives in the lazy `office.js` group drawer, the photo rides the lazy `dispatch.js`
// picker row, and `office.css`/`dispatch.css` gained the avatar rules — none of it in the
// shell itself, so `index.html`/`app.js` are byte-identical and the 160 KB budget is untouched.
// **v167..v190 were all spent on other branches** (v167 is the facet-panel change on this very
// line; v187..v190 on `deploy/rx10-silent-followup`), so this takes v191 — unused everywhere.
//
// v192: the HDMI-laptop dashboard tier (2026-09-01). A fourth responsive tier in `index.html`
// — `min-width: 64rem` AND `max-height: 51rem` — puts the wall's three columns on a 1366×768
// laptop-over-HDMI and compresses the vertical rhythm so every activated panel is on one
// screen with no scroll. `dashboardLive` test 23 guards it; test 14 (the 1920×1080 wall) is
// untouched because 1080 > 51rem. This DID grow `index.html` (~1.2 KB raw / ~0.5 KB gzip), so
// the same pass moved `m1gate.e2e` test 3 off raw bytes onto the **gzipped** artefact Caddy
// serves (O-Caddy-1): shell on the wire is ~40 KB against a new 52 KB budget.
//
// v193: ADR-0031 phases 3+4 — the department vocabulary leaves the client (2026-09-01).
// `web/src/roster.ts` / `web/src/admin.ts` call the flat `POST /roster/posts`,
// `POST /roster/people`, `GET /roster` (no more `/roster/<nil-uuid>/…`) — that scoped route was
// what answered the console's bare `POST /roster/people` with `{"error":"no such department"}`
// on the live *add contact* button. `web/src/main.ts` drops the per-department "Reach them"
// buttons on the incident screen (`contact.ts` import + the `responsibleDepartmentIds` loop;
// `web/src/contact.ts` is deleted) and the board's `department` facet group; its
// `Identity.tier` type is `'post' | 'district' | null`. `web/src/admin.ts` drops the dead
// `examplesAre` field. v191/v192 were both spent on production before this branch merged, so
// the whole ADR-0031 client change takes v193 — unused everywhere.
//
// v194: the admin console's Directory tab is wired to `/roster/contacts` (2026-09-01). ADR-0031
// killed `{"error":"no such department"}`, but adding a contact still did nothing visible: the
// tab listed from `/contacts/recipients` (posts) and its Add button posted a bare
// `/roster/people` — a person with no post, which a post-keyed list never shows. It now reads
// `GET /roster/contacts`, adds with `POST /roster/contacts` (name + designation + number, one
// transaction, ADR-0029), and Save / Remove actually call `PATCH` / `DELETE` instead of just
// closing the drawer. Add/edit is gated on `editable`, and Remove is withheld on the last
// administration-ticked contact. `web/src/admin.ts` only — no server change.
//
// v196: the Settings panel — ADR-0032 phase 3 (2026-09-01). A new top-level nav item
// `#navSettings` (shown to owner/admin, the server refuses regardless — INV-05) opens a lazy
// `settings.js` / `settings.css` bundle: Overview (counts as doors) · Accounts (add, reset,
// suspend, change role, restrict, force sign-out, remove — every destructive act asks a reason,
// INV-06) · Access log (read only) · Security policy (read only this release). Profile menu
// gains **Change my password** for every account, and a `must_change_password` account is held
// on that dialog until it changes. `index.html` gained the nav button, an empty `#settingsView`
// and the `#changePw` button; `app.js` gained the wiring and a small forced-change dialog.
// `settings.css` is held under this string by the generic handler, like `office.css`, and
// `/settings` joins `NEVER_CACHE` so a re-read after an account change is never answered stale.
//
// v196 (folded in, from origin/main): delete / remove stops asking the operator *why*
// (2026-09-01). The roster's own `prompt()`s and the four `ask()` dialogs that collected a
// reason before removing a person, retiring a post, deleting a group or clearing an SLA
// exception now just confirm the action. The server and the config log still require a reason
// (INV-06 — the actor, the seat and the time are what that invariant turns on), so the console
// sends a fixed one. `web/src/roster.ts` and `web/src/admin.ts` only — no server change.
//
// v197: ADR-0032 phase 4 — the move (2026-09-01). *Which screens are on* (ADR-0016) and
// *Dashboard layout* (ADR-0015) leave the Administration console for the Settings panel as two
// new tabs; they gate on `capabilities.write` / `dashboard_layout.write` (server, INV-05). The
// console keeps a signpost (`#installationMoved`) where the group stood. `settings.js` /
// `settings.css` and `office.js` all changed; `index.html` loses the dead `#adminLayout` rules
// and the preview-iframe rules move to `settings.css`.
//
// v198: the Settings panel's UI actually matches Administration and the Record now (2026-09-01,
// UI only — no endpoint, no `data-*` value and no behaviour moved). `#settingsTabs` is the
// grouped, sticky left rail `#adminTabs` is instead of a row of pills; `index.html` wraps the
// error + body in `#settingsMain` (the `#adminBody` equivalent); the *Restrict or elevate*
// overrides editor slides in from the right as a drawer, `createDrawer()`'s treatment, rather
// than opening as a centred `<dialog>`. `settings.ts` + `settings.css` + one `index.html`
// section.
//
// v199: the Record's Left Sidebar is `position: sticky` with its own scroll (2026-09-01, CSS
// only in `index.html`). It was a plain grid item, so selecting a row and scrolling a long
// list carried the whole sidebar off the top with the rows; now it holds still and scrolls
// its own content on a viewport too short to hold the filters and the KPI strip together. The
// `@media (max-width: 1024px)` one-column breakpoint resets it to `static` so a stacked
// sidebar travels with the page as before.
//
// v200: the Settings panel finishes matching Administration (2026-09-01, UI only — every
// endpoint, `data-*` value and behaviour is unchanged). The rail carries a right-aligned
// `.settings-badge` per tab (`#adminTabs`'s `.badge-count`, recoloured `--primary` on the
// current tab) so it reads with the same weight. Every editable row now opens a
// right-hand drawer instead of an inline control: an account row → a `Manage` drawer with
// reset / suspend / change role / restrict / force sign-out / remove; *Add account* is a
// one-form drawer, not a three-step `ask()` chain; a *Which screens are on* row and a
// *Dashboard layout* row each open a drawer for their toggle / size+order+remove; an access-
// log row and a security-policy row open a read-only detail drawer. `settings.ts` +
// `settings.css`.
//
// v201: a group member reads "Name — Post" (2026-09-01). The console's Groups tab — the
// add-from-directory picker and every resolved member on a card and in the drawer — showed the
// post alone; the district asked for who somebody is as well as what they hold. `api/groups.ts`
// composes "holder — designation" (or the bare designation for a vacancy); `web/src/admin.ts`
// (office.js) composes the same string for the picker. Server + office.js only; `index.html` /
// `app.js` are byte-identical.
//
// v202: the intake "Who should know?" picker is tidier (2026-09-02). A saved group's row is
// the name + a member count (`6 members`) instead of every member spelled out — the full list
// moves to the row's `title` so the black-box concern (M7-14) is still answered. A contact row
// is name-first: a post held by a real officer shows that officer's name as the label with the
// designation on a quieter line beneath (a vacant / stand-in post keeps the designation as the
// label). `web/src/dispatch.ts` + `web/dispatch.css` only — both lazy (`dispatch.js`), so
// `index.html` / `app.js` are byte-identical.
//
// v203: the Record's header band is tightened (2026-09-01, CSS only in `index.html`). The
// stack between the tab bar and the queue — the Rows/Summary/Download row (`#boardViews`),
// the scope card (`#boardScopeBar`) and the "N withdrawn today" bar (`#boardWithdrawn`) —
// carried ~120px of padding and stacking margins that read as dead space on an office
// screen. Padding and margins step down onto the `--s*` scale: `#boardViews` /
// `#boardScopeBar` bottom margin `--s5` → `--s3`, `#boardScopeBar` padding `16/20` →
// `10/16` and gap `--s3/--s5` → `--s2/--s4`, `#boardWithdrawn` top margin `--s5` → `--s3`,
// `.admin-split-layout` top margin `1.25rem` → `--s3`, `.search-header-box` `12/16` +
// `0.5rem` → `9/14` + `0`, `.right-content` gap `12px` → `10px`. No font size, `id`,
// `data-*` or behaviour moved (`#boardScopeWhat` stays `--t7`, ADR-0020); the same tokens
// carry to the other panels. Measured at 1920×1080: content 46px higher, header 65px.
//
// v204: officer availability is a manual two-state roster (ADR-0033, 2026-09-02). The Status
// screen's five presence buttons + `until` datetime become two — Available / Unavailable — set
// by hand, plus a "Show on dashboard" checkbox POSTing `/status/presence/wall`. The Dashboard
// availability panel carries name AND designation for the seats the control room curated onto
// the wall (`.pofficer`, a scoped exception to ADR-0013 §1). `web/src/status.ts`,
// `web/src/dashboard.ts`, `web/office.css`, `web/index.html`. v203 taken by the Record header.
//
// v205: the Groups drawer's "Add Member From Directory" gets a search box (2026-09-03). It was
// a plain `<select>` listing the whole directory with no filter — the owner could not find
// anyone in it. Replaced with a text input (`pickerInput`) over a live filtered results list
// (`redrawPicker`), matching name or phone, each result an Add button; already-enrolled members
// are excluded and reappear when removed. `web/src/admin.ts` (office.js) + `web/office.css`
// only (`.picker-results`, `.member-add-btn`).
//
// v206: the console's sidebar Directory / Groups badges show a live figure (2026-09-03). They
// were hardcoded strings in `buildTabs` — `'207'` and `'11'` — so the Directory badge read four
// short of the "District Directory" card beside it the moment a contact was added (the card
// reads `GET /roster/contacts` live; the badge was a literal). `admin.ts` now seeds them with a
// placeholder and fills each from the same response its tab is drawn from (`renderOverview`,
// `renderDepartments`, `renderGroups`) via a new `setTabBadge` helper. `office.js` only — no
// server change. This commit also re-records `shell-version.json`, which v205 shipped stale.
//
// v207: the Groups create/edit drawer opens on its members now (2026-09-03). `openGroupDrawer`
// appends ENROLLED RECIPIENTS + `membersBox` directly under "Search Group Member", then "Add
// Member From Directory" as a `.d-btn` toggle. `pickerInput` + `pickerResults` are wrapped in a
// `pickerBox` that ships `hidden`; the toggle unhides it, marks itself `.primary`, runs
// `redrawPicker('')` and focuses the input, and a second click clears + collapses. The initial
// `redrawPicker('')` at render is gone — the list builds on open. No behaviour changed (the
// search, the 8-result cap, the Add buttons, the already-enrolled exclusion, the
// remove-refreshes-picker link are all intact). `admin.ts` (office.js) only.
//
// v208: a rejected contact form reports INSIDE the drawer now, not in the top `#adminError`
// banner (2026-09-03). The owner deleted a contact, tried to re-add it, and got "a contact with
// that phone number already exists" — the banner appearing above `#adminBody` shoved the whole
// tab down while they were looking at the drawer. `createDrawer` gains an `errEl` between head
// and body and a `sink`; `api()` takes an optional `sink` (default: the top banner); the three
// contact drawers pass `drawer.sink`. `admin.ts` (office.js) + `office.css` (`.drawer-error`).
// The re-add bug itself is the server half — `removeContact` now marks the holder `removed_at`.
//
// v209: the Groups "Add Member From Directory" toggle moves ABOVE the enrolled list (owner:
// "es ko upar le ao"), the directory picker gains a tickbox per row plus one "Add selected (N)"
// button so several contacts go in at once, and a contact already in the group now SHOWS in the
// search with a ticked, disabled box and an "Already in this group" tag instead of being
// filtered out. `picked` is a Map that survives a redraw so narrowing never drops a selection.
// The per-row "Add" button and its `.member-add-btn` CSS are gone. `admin.ts` + `office.css`
// (office.js / office.css) only, no server change. Rebased onto v208 (a co-agent's drawer-error
// change that landed on `main` mid-build); this takes v209.
//
// v210: the nav's screens are prefetched in the background on sign-in (2026-09-03). Opening a
// panel felt slow because every screen but the Record is its own lazy `*.js` (+ `*.css`) bundle
// fetched on the first click — a ~150 ms Helsinki round trip before the panel could mount, and
// a round trip on the first open *after every deploy*, because this `CACHE` bump empties the
// generic-handler cache that holds those bundles. `paintIdentity` now appends
// `<link rel="prefetch">` for office/dispatch/compose/search/report/reports/settings/help (js +
// css) at idle once sign-in completes — a signed-in seat is an office laptop (ADR-0018) and will
// open them. It warms the browser cache and through it this service worker's, without executing
// any bundle twice. `web/src/main.ts` only; `index.html` byte-identical, shell budget untouched.
//
// v211: the DATA those panels open onto is prefetched too (2026-09-03). v210 warmed the *bundle*;
// with it in hand a panel still opened onto "Loading…" while its overview `Promise.all` made one
// ~150 ms round trip to Helsinki. `prefetchScreenData` in `main.ts` fetches the GET each panel's
// landing tab fires — `/roster/contacts`, `/admin/{integrity,backups,groups}`, `/settings/accounts`,
// the two access-log windows, `/status`, `/summary` — at idle after sign-in and holds each in an
// in-memory map. The panels' request helpers drain it: `__dncPrefetchGet` hands a value back once
// (one-shot, deleted on read) and only within 20 s, so every re-open, tab switch and Refresh goes
// to the server exactly as before. These are `NEVER_CACHE` routes, so the copy lives in the page,
// not here. `web/src/main.ts` + `admin.ts` + `settings.ts` + `status.ts` + `reports.ts`;
// `index.html` byte-identical, shell budget untouched.
// v212: the Record's incident drawer is to-the-point (2026-09-04). The owner said the drawer
// confused DC staff — "full history", provenance and a crammed header where a control room wants
// what is happening now. It opens on an **Overview**: a status/deadline pill row, five plain-word
// tiles (Stage as a 4-step bar, Reported "48 min ago", Deadline with its target in minutes,
// Assigned to, Priority), "The alert we sent" and "The response we received" verbatim in matching
// quote blocks, a per-recipient status list, "Latest update", "Next step" and "How it came in".
// The raw event log moves to a **History** tab. Every behaviour is kept — Correct this, Withdraw /
// Restore, Take action, both report forms, who-was-told acknowledgement — moved, not removed. The
// server's `/incidents/:id` now carries an `sla` snapshot for the Deadline tile. `index.html` +
// `web/src/main.ts` + `api/lifecycle.ts`.
// v213: two follow-ups from the owner opening v212 over a real single-recipient report (2026-09-04).
// The "Assigned to" tile said "see recipients below" — a tile that pointed at the section under it
// and named nobody; with nothing routed it now names the recipients themselves (a routed department
// still wins). And "Status by recipient" still drew the `1 told · 1 confirmed · 0 silent` tally over
// a lone recipient — three numbers restating the one row beneath them; the tally (`.ackline`) is now
// drawn only for two or more recipients, where the subtraction it saves is real. Chase line and the
// ownerless flag are unchanged. `web/src/main.ts` + `web/src/dispatch.ts`; `index.html` byte-identical.
// v214: the drawer's status pill and Stage step bar were stuck (2026-09-04). The v212 redesign
// compared `data.stage` — lower-case from `stageOf` — against capitalised `'Responded'` /
// `'Acknowledged'` / `'Resolved'` and a capitalised `STAGE_STEPS`, so no branch ever matched: every
// non-closed incident showed "Awaiting response" and the bar sat on step 1. Lower-cased the
// literals and the array, tightened `Detail.stage`'s type from `string` to the four-word union so
// `tsc` catches the class. `web/src/main.ts` only; `index.html` byte-identical.
// v215: the owner asked what "no desk assigned / not routed" meant — and it means nothing, which is
// the point (2026-09-04). Routing an incident to a *department* is how "who holds this" was ever a
// question apart from "who was told"; ADR-0030 deleted the department table (migration 0039) and the
// route with it, so `responsibleDepartments` is empty on every live incident for ever and the tile
// had no fact of its own — it either pointed at the recipient section or copied it. It is **"Taken
// by"** now: the seat that acknowledged, or "not yet taken" until one does. `web/src/main.ts` only;
// `index.html` byte-identical.
// v216: `Acknowledged` is gone as a stage, everywhere on the shell (2026-09-04) — the owner's own
// words, "jaha jaha acknowledge ka concept tha wo ab khtam". The four-word wall (Issued →
// Acknowledged → Responded → Resolved, M9-25) is three; the Record drawer's Stage bar and status
// pill drop the middle step; the dashboard's district-counters deck loses the `Issued`,
// `Acknowledged` and `Not yet assessed` tiles, keeping exactly the owner's five (Reported today,
// Responded, Resolved today, No one chosen, Message failed); the "Responded" field on the drawer
// (was "Acknowledged") reads the same `acknowledgedAt` timestamp, unchanged underneath — it is the
// moment the SLA clock stopped, which ADR-0034 means is now the officer's response itself; the
// admin console's SLA screen reads "Response Deadlines" rather than "Acknowledgement Deadlines";
// the in-app help teaches the three words and explains the fourth is gone. Nothing here touches a
// Meta template or the still-live `/ack/` link workflow, both deliberately out of scope. `web/src/
// dashboard.ts` + `main.ts` + `admin.ts` + `dispatch.ts` + `help.ts` + `incidentRow.ts`;
// `index.html` byte-identical.

// v223: the device GPS fix that rode alongside "Where is it?" for one day comes out again
// (2026-09-05, the owner: "map location ghalt hai, es ko remove kro, control room location khud
// likhege" — the map pin was wrong, remove it, the control room will write the location itself).
// v221 below built a tappable Google Maps link from `navigator.geolocation` and joined it to the
// typed text on the WhatsApp message and the Record row's title; both the link and the background
// watch are gone. `location.ts`'s `Capture`/`buildCapture` carry `text` only now, the `#where`
// status line ("Finding your location…") is removed from the report form along with the watch
// that fed it, and `domain/communications.ts`'s `locationLine` reads `location.text` and nothing
// else — `ReportedLocation` has no `gps` field left to read. Typing the place by hand is
// unaffected; it is now the only layer there is. `index.html` + `main.ts` + `location.ts`.

// v224: "Where is it?" moves out of `.rcolwide` (below `#submit`) and into `#whatBlock`, beside
// "Incident details" (2026-09-06). The owner sent a live Alert, never scrolled past the big red
// button to the box trailing under it, and the WhatsApp message went out reading "no details were
// entered" — the exact defect a location box exists to prevent. It is a control-room field above
// the button now, where an operator with a caller on the line will see it; a field seat never
// reveals `#whatBlock`, so the two-tap critical path (M0-36) and `rapidIntake.e2e` test 1 are
// untouched. `index.html` only — no behaviour changed, `#place` keeps its id and its wiring in
// `main.ts`. The "location.text rides the reported event" browser check moved from
// `rapidIntake.e2e` (a field seat) to `compose.e2e` (a district-tier operator).

// v225: two changes to the Record (2026-09-06). (1) **It opens newest-first, from every door.**
// `boardSort` starts at `-age` — an order `board.ts` already offers and validates — instead of
// the server's triage rank (`compareRows`), so the top row is the most recent incident however
// the Record was reached: the nav, a Dashboard figure, a search, a shared link. A `sort=` in the
// URL still wins, every column header still works, and "Queue order" resets to triage. Every
// other caller of `buildBoard`, the wall board included, is untouched. (2) **The detail drawer's
// footer stops crowding the reading area.** `#takeAction` goes flush — no --card2 card, no 14px
// padding — and Report / Plain text / Correct this / Withdraw shrink to one quiet wrapping line
// (`--slate`, `--t1`); the "Take action" buttons come down to a 36px control-room mouse target
// (ADR-0018), and `.drawer-body` (already `flex: 1; overflow-y: auto`) takes back the freed
// height. CSS plus one client sort default: no markup, no id, no behaviour changed.
// `web/src/main.ts` + `index.html`; `board.e2e`'s truncated-Record route glob gains a trailing
// `*` for the `&sort=-age` tail the board now sends.

// v226: v225 landed but did not match what the owner asked for, so both halves are redone
// (2026-09-06). (1) **The Record opens on the most recently *entered* incident, not the most
// recently *occurred* one.** `-age` sorts on `occurredAt` — a report filed now about last night
// sinks to last night — so a new `recorded` key in `BOARD_SORTS` orders on `arrivedAt` (the
// incident's first `reported` event reaching the server), added to `IncidentState` and
// `BoardRow`. The Record opens on `-recorded`; URL `sort=`, every column header and "Queue
// order" are unchanged. (2) **The drawer's record tools go into a real `···`-style "More"
// menu**, not the half-measure of smaller inline buttons v225 shipped. `#detailMoreMenu` holds
// Report / Plain text / Correct this / Withdraw (same ids, listeners and `confirm()` dialogs —
// only the parent node moved); it opens upward, closes on a pick, an outside click or Escape.
// The footer now shows the "Take action" row and one small button, and `.drawer-body` takes the
// rest. `incident.ts` + `board.ts` + `board.test.ts` + `main.ts` + `index.html`;
// `detail.e2e` / `search.e2e` / `withdrawal.e2e` open the menu before touching a tool.

// v227: the incident drawer stops being a window inside a window (2026-09-06). It is a fixed
// panel over a full-height backdrop, but the document behind it kept its own scroll, so an
// incident opened on a laptop showed `.drawer-body`'s scrollbar with the page's own running
// right beside it — two bars, and the owner asked for one. `body:has(#detailView:not([hidden]))
// { overflow: hidden }` freezes the document while an incident is open, so `.drawer-body` is the
// only thing that scrolls. `index.html` only — one CSS rule, no markup, no id, no behaviour
// changed; `shellVersion.test.ts` requires the bump because `index.html` moved.

// v228: **the Record's own view carries closed rows too** (2026-09-06, the owner's call).
// `?open=1` — the view the nav, a shared link and a cleared search land on — was *what is still
// open, any day*, so a report resolved by lunchtime was nowhere on it while a stale still-open
// case sat on top. It now folds open and closed alike, still ordered `-recorded` (newest
// entered first), so however the Record is reached the newest thing is at the top. `open` is a
// historical param name for this whole-record view; the day views are untouched (still
// live-work only, `?closed=1` unchanged). One server line — `includeClosed: true` in the
// `openOnly` branch — plus wording: `server.ts` + `main.ts` + `index.html` + `help.ts`;
// `districtDay.test.ts` + `board.test.ts` gain a closed-row-included assertion.

// v229: the incident drawer becomes one window (2026-09-06, the owner's call). "Take action"
// and the "More" menu were a fixed band under the scroll (`flex: 0 0 auto`); with the head
// above it, the record was squeezed into a letterbox an operator read by scrolling — a window
// inside a window. `#detailFoot` now flows as the LAST block inside `.drawer-body`, so the
// scroll surface is the whole drawer and the record gets every pixel between the head and the
// bottom edge — you read the incident, then you reach the buttons. The band loses its
// full-bleed `--card2`, its reserved height and its own padding (a hairline + `padding-top` is
// all that marks it); the live actions go two-up in a grid, and a disabled action's reason
// takes a full row so it is never wedged between two buttons. `index.html` only — CSS plus one
// moved DOM node, no id and no behaviour changed; `shellVersion.test.ts` requires the bump.

// v231: the post-incident report names who acknowledged (not only which post), lists every
// recipient with delivery and their reply in a "Who was told" section, tags a narrative line
// that happened after resolution, and reads "no post was assigned" instead of the stale
// "routing matched no department". Every human-facing actor name leads with the person, then
// the post (ADR-0035) — the Record drawer's "Responded by" tile and the Administration change
// log are the shell-side changes here. `main.ts` moved, so `shellVersion.test.ts` requires the
// bump.

// v232: a dashboard panel expands into a read-at-rest drawer (ADR-0036). Panels that carry
// more rows than fit travel on the wall; expanding one lifts its list node into a shared
// right-side drawer where it sits still, all of it at once, and a row still leads where it
// always did. New `web/src/drawer.ts` (bundled into `dashboard.js`) is the slide-in written
// once; `index.html` gains the `.od-*` block and the heading expand glyph; `dashboard.ts`
// gains `mountExpanders`/`expandPanel` and `flowPanels` skips a panel that is in the drawer.
// `index.html` + `dashboard.js` moved, so `shellVersion.test.ts` requires the bump.

// v233: the panel drawer, two fixes the owner caught in the first cut (ADR-0036). (1) The
// borrowed rows rendered with the wall's full card depth — tilt, moving light, lifted-text
// shadow — because `#dashboardView .panel … .z*`'s flatten rule cannot reach `.od-body`; it
// is restated there, with the sheen / rim / cast / rotation switched off, so the drawer reads
// flat and clean. (2) On close the list went back into `.lift` bare, and `flowPanels` only
// re-wraps it in its `.pflow` travel window on the next poll — so the panel sat the wrong
// height and shoved the wall's layout for up to 20s; `expandPanel`'s `onClose` now calls
// `flowPanels()` so it heals in the same tick. `index.html` + `dashboard.js`.
// v234: the travelling status cards show three rows, not one. On the HDMI-laptop tier
// (`min-width: 64rem` AND `max-height: 51rem`) `--pflow-h` was `4rem` — a single row — so the
// district watched every service in `utilities` / `presence` / `importantEmergencies` /
// `routineEmergencies` / `stillRunning` crawl past one at a time. The owner asked for at least
// three visible at rest; the window is now `10.5rem`, the wall's own. Five windows six rem
// taller costs the HDMI-driven Dashboard about a screen of extra height, so it now scrolls a
// little — the owner chose the three rows over the no-scroll. `dashboardLive` test 23 rewritten
// to that intent. Wall tier (1920×1080) untouched. `index.html` CSS only.

// v235: the "who was told" list carries ADR-0035 to the RECIPIENT it left name-only. A
// dispatched officer showed as their name alone on the incident drawer's "Who was told"
// panel, on the board's `who` column, in the response breakdown and the CSV export; now they
// are `Rustam Khan — DDMA` — name then the post they hold longest (`dutySeatOfPerson`'s rule)
// — the district's own shape in `backlog/whatsapp-response-workflow.md` §6. `actorsFor` carries
// the post as `personSeats` (provenance's `people` map stays bare); `main.ts`'s `nameForTarget`
// composes it, `board.ts`'s `dispatchNames` does the board/dashboard, and
// `domain/recipients.ts`'s new `withDesignation` the reports — same ` — ` separator ADR-0035's
// `actorName` uses, collapsing to one string where name and post restate each other. A `post`
// recipient is unchanged. `web/src/main.ts` moved, so `shellVersion.test.ts` requires the bump.
// (v234 is nawaz-ae's parallel dash-cards `--pflow-h` change; numbers need only be unused.)

// v236: an emergency card with nothing open leaves the wall. The owner's ask (2026-09-08) —
// `routineEmergencies`, `importantEmergencies` and the `alerts` panel read as clutter on a wall
// meant to be scanned when their body is empty, unlike a status list whose "nothing configured
// yet" is itself a fact. `renderImportancePanel` and `renderAlerts` now set the same `data-empty`
// mark `renderCondition` has carried since M6-30; `applyLayout` already keeps a `data-empty="true"`
// section hidden without dropping it from the arrangement, so the card returns the moment a row
// arrives. The always-there panels — `utilities`, `services`, `keys`/`facts`, `presence`,
// `stillRunning`, `situation` — are untouched. `dashboard.js` moved, so `shellVersion.test.ts`
// requires the bump. (v235 is nawaz-c5's parallel "who was told" change.)

// v237: a dispatched POST names its holder too. `v235` gave a `person` recipient on the "who
// was told" list its held post (`Rustam Khan — DDMA`) and left a `post` recipient — which a
// learned proposal usually is — reading its title alone; the owner tested with one
// (`DNC-BAJAUR-82` -> the seat "IT Soft") and saw no name. The list answers *which human was
// reached* either way, so a `post` now reads `Imtiaz Ahmad — IT Soft`, its current holder then
// its title. `actorsFor` carries `seats[id].holder` (absent for a vacant post; provenance's
// `nameOf` reads only `title`), `dispatchNames` does the board / dashboard, `main.ts`'s
// `nameForTarget` composes both arms with one helper, and `domain/report.ts` / `api/reports.ts`
// the reports via a new `seatHolders`. `web/src/main.ts` moved, so `shellVersion.test.ts`
// requires the bump. (v236 is nawaz-ae's parallel empty-card change.)
// v238: "Status by recipient" stops repeating the message the record already printed. The owner
// photographed `DNC-BAJAUR-79` (2026-09-08): the fire alert's four lines sat under *"The alert we
// sent"* and then again under every one of the three recipients — one sentence, four copies, with
// *replied on WhatsApp* and what each officer actually said pushed down the screen by a paragraph
// the reader had just finished. `.tsent` went on the row on 2026-08-24 to answer *"kis ko kya
// gaya"* wherever an incident was told twice, and that question is real — a second alert goes out
// about a reassessed severity — so `renderWhoWasTold` draws it only where the recipients hold
// DIFFERENT words. They agree, the line above is the whole answer; two of them differ and every
// row carries its own. `dispatch.js` / `dispatch.css` moved, so `shellVersion.test.ts` requires
// the bump.
// v239: the Status screen's cards drop their age and gain Add / Remove / Rename. The owner,
// scoping it twice: *"just status wale pannel sai time dikhana hatana chah raha hon … stutus sai
// bahar kese bhi jaga sai nhe hatana"*, and *"only and only Status ki andar cards mai"*. 🔴 THE
// WALL KEEPS ITS AGE — [ADR-0025] answered INV-02 with *the row is dated rather than degraded,
// and the wall prints the age beside the status*, and `dashboard.ts`'s `renderStatusList` is
// untouched; a later tidy-up of "the same age in two places" must not reach for it. On the two
// condition panels the removed span had stopped carrying an age at all: since [ADR-0030] every
// `departmentName` is null, so its only live branch read *"nobody assigned"* on every row. The
// controls are `canConfigure`-only, and on the officers **Add / Remove mean this panel on the
// wall and never the post** — a designation is created and retired on the Roster, so this is
// [ADR-0033]'s curated pick with its checkbox said as two words. `status.ts` / `office.css`
// moved, so `shellVersion.test.ts` requires the bump. (v238 is the parallel "who was told"
// change and is already on Bajaur.)
// v240: the wall's three status panels drop their age too — the district asked twice. v239 above
// says in capitals that the wall keeps its age, and one day later the owner read that sentence
// back as the bug: *"yaane k dashboard pr time abhi bhi dikh jaega????"*. They were shown INV-02
// and [ADR-0025] — that the age was the WHOLE of those two panels' answer to it, since ADR-0025
// removed their expiry on the district's own instruction — and offered a middle (print it only
// once a reading goes old). They chose it gone. 🔴 SO A FOUR-DAY-OLD *Normal* NOW READS EXACTLY
// LIKE A FRESH ONE on the two condition panels, and [ADR-0037] is the argument rather than an
// oversight to correct. Officers lose nothing: presence still expires, so a stale row greys
// through `toneFor` and takes the `last said:` prefix — INV-02's degrade form, which never
// needed a number. Only `renderStatusList` changed; alerts, incidents, weather and the headlines
// still print their age and still climb, and `dashboardLive`'s carried-open `.cage` guard is
// what proves the shared `ageSpan` machinery was not touched. `dashboard.js` moved, so
// `shellVersion.test.ts` requires the bump.
// v241: the Record's Summary view stops opening underneath the Rows view's furniture. Clicking
// Summary left a facet sidebar counting rows it does not show, a search box filtering a table
// that is not there, "Showing 24 Incidents" over no incidents, Queue order / Compact for a queue
// that is gone, and an empty grid column the height of all of it — the figures pushed below the
// fold on the screen somebody opened to read them. ⚠️ THE CAUSE IS THAT `ROWS_ONLY` HIDES BY ID
// AND THE 2026-08-31 REDESIGN ADDED CONTAINERS WITH NO ID. It rebuilt this screen into a
// two-column `admin-split-layout` and a `.viewtools` group; neither could be named in the list,
// so neither was ever hidden. They gain `#boardSplit` / `#boardTools` and both are added.
// 🔴 NAMING THE CHILDREN WOULD NOT HAVE BEEN ENOUGH, and each container also needs a
// `[hidden]` rule of its own: an author `display` (`grid`, `inline-flex`) beats the UA sheet's
// `[hidden] { display: none }` whatever the specificity, so without it the list entry is a
// silent no-op — the same shape as `.d-panel[hidden]`. Separately `#boardUnassigned` WAS in the
// list and came back anyway: the board keeps refreshing while Summary is open and `renderBoard`
// reasserted it every time, so it now reads `boardRowsVisible` like `paintBoardTruncation`
// already did. Rows is restored by re-running its state, never by blanket unhiding — the two
// containers are asserted (they are always on screen in Rows, like `#boardScopeBar`) and
// everything inside stays owned by its own painter. `index.html` and `app.js` moved, so
// `shellVersion.test.ts` requires the bump.
// ⚠️ **v241 WAS CLAIMED TWICE, AND THAT IS WHY THIS READS v243.** The paragraph above was
// written against v241 on the Bajaur box, where the fix was committed and deployed but never
// pushed; `main` meanwhile spent v241 on the console's restored Rosters tab and v242 on the
// Status screen keeping what an operator has typed. Two different shells under one cache key is
// the exact failure this string exists to prevent, so the two lines were brought together and
// given a number neither had used. Nothing above is amended — it describes the change it
// describes, and that change ships here.
//
// v243 therefore carries all of it: the Summary/Rows fix above, the Rosters tab back in the
// console nav (its entry was deleted by a commit that only meant to rename a label), the
// Reports screen's 44px touch targets restored, and the Status screen no longer discarding a
// half-typed advisory when a save repaints the panel.
// v244: the sign-in screen is a door rather than two boxes. The owner, 2026-09-08 — *"login wala
// window sahe nhe lag raha hai … advance login window … jis k background mai liveness ho"*. What
// stood there was a phone field, a password field and a button in the same column as the intake
// form with nothing around them: the first screen anybody in Bajaur sees, and the only one in the
// product with no crest, no depth and no motion in it. `#loginView` now holds a stage — crest,
// district line, three sentences and the form on a lifted card — with the dashboard's own ambient
// light behind it: a 38s drift, the same 100deg band the cards catch, and two rings leaving the
// crest. CSS and pseudo-elements ONLY, on the 2026-08-16 rule (`signatureOf` compares a rebuilt
// node by `outerHTML`, so nothing may write a class to animate), and it renders no figure —
// a signed-out browser is told nothing about the district and is not about to start being told
// for decoration. INV-01 is why it is a band and not an overlay: the intake form below it still
// takes an emergency with no account, and the card links straight down to it. `button.plain` on
// this card turns violet — it filled with `--critical-fill`, the same red as the emergency report
// button four centimetres below it. `index.html` moved, so `shellVersion.test.ts` requires the
// bump.
//
// v244 also carries the wordmark off the clock. `h1` is `white-space: nowrap` and its inner
// `<div>` had no `min-width: 0`, so the brand could not shrink below the 224px the title needs:
// the flex row squeezed the brand’s BOX and the title overflowed it. Measured on the built shell,
// the district’s own name ran to 283px while `.now` began at 231px on a 390px screen — 52px of
// overlap, on EVERY screen in the product, not only this one. Below 30rem the title wraps at
// `--t3` on a 1.15 line-height instead: shrinking cannot win (at 320px the brand has about 92px
// for it), and an ellipsis would be invisible, because `h1` paints through `background-clip: text`
// over `color: transparent` and the browser paints the ellipsis in `color`. Header height 72 -> 82
// at 390px.
//
// v245: the signed-out report form is collapsed behind "Report an emergency" instead of open
// the instant the page loads — the owner's instruction, 2026-09-09, on top of v244's door. The
// link now also says the form works with no connection at all. `reportRevealed` in `main.ts`
// hides `#reportView` while signed out and un-hides it once, on the click; never re-hidden
// afterwards, so a reconnect or an online/offline flip mid-report cannot pull the form out from
// under somebody. Same commit: `#whatBlock` ("Incident details", "Where is it?", the message-kind
// tiles) stops being administrative-seat-only and is shown unconditionally — the owner asked for
// the control room's own rich form for everyone, and was told first that the two-tap no-typing
// critical path (M0-36) is not universal any more, because those two boxes now sit above
// `#submit` on the narrow layout too. Chosen anyway; `rapidIntake.e2e.test.ts` test 1 was
// inverted rather than deleted to keep the trade visible. `index.html` and `app.js` moved, so
// `shellVersion.test.ts` requires the bump.

// v246: the post-incident report opens with the district's official letterhead (2026-09-09).
// The owner downloads this page — browser Print -> Save as PDF — and it carried only the
// software's "Post-incident report — <kind>" line, no crest, no office. `web/src/report.ts`
// now prepends the Deputy Commissioner, Bajaur masthead to `#piReportBody`: the district seal
// (the mark on the district WhatsApp number) as an inline base64 JPEG `<img>` — an `<img>` and
// not a CSS background so it prints with "Background graphics" unticked — then "Office of the
// Deputy Commissioner", "District Bajaur", "Government of Khyber Pakhtunkhwa", a double rule, and
// "District Nerve Center · DNC Bajaur" beneath. `web/report.css` gained the `.reportLetterhead*`
// rules, screen and print. Both files are in the LAZY `report.js`/`report.css` group — no shell
// bytes — but both are hashed into the shell digest and held by the generic fetch handler under
// this string, so a browser that already has them keeps the old ones without this bump.
// ⚠️ The letterhead is a `<div>`, never a `<header>`: `report.css`'s print rule hides every
// `header` on the page, and `search.e2e.test.ts`'s "prints the report and nothing else" asserts
// no `header` survives print — a `<header>` here would either fail that test or not print.

// v247: the incident drawer names the office that TOOK a wide dispatch, not the one that tapped
// first — Option C, Phase 2 (2026-09-10). On a message to more than one recipient the drawer's
// "Taken by" tile, "Responded" row, "The response we received" quote, "Next step" line and the
// overdue pill read the server's new `response` roll-up (`ownershipOf`) instead of the fold's
// single first-tap `acknowledgedBy*` slot, which has been naming whoever answered first — a
// decline included. A wide dispatch everyone declined ("`ownerless`") now reads "not taken —
// reassign" and keeps its deadline running. Single-recipient incidents are untouched: the slot
// and the roll-up name the same office, and the drawer only switches once `told > 1`. Also wires
// `readIncident`'s `sla` snapshot into the detail payload — it has been computed and dropped on
// the floor since v212 (2026-09-04), so the Deadline tile has read "no deadline" on every
// incident; it now shows the same "12m overdue" / "on track" / "met" the Board's row shows.
// `web/src/main.ts` moved, so `shellVersion.test.ts` requires the bump.

// v248: when a notice asked who is coming, the incident drawer shows ATTENDANCE, not a single
// answer — the Case 2 (meeting) work, Phase 2 (2026-09-10). For a `meeting` (and any
// `asksAttendance` notice) the server now sends an `attendance` tally on the detail payload, and
// the drawer's fourth tile reads "Coming — N of M" not "Taken by", the "Responded" row becomes
// "Replies — N of M answered · count closes …", and "The response we received" becomes "Who is
// coming": the summary sentence ("3 of 5 coming — 2 attending, 1 sending someone, 2 silent") and
// every person asked with the answer they gave. The "Next step" line and the "Response" quick
// string follow. Every other kind (`attendance` null — emergencies, plain notices, `schedule`)
// is byte-for-byte unchanged. `web/src/main.ts` + `index.html` (`.d-attendance` styles) moved,
// so `shellVersion.test.ts` requires the bump.

// v249: the Record row for a notice that asked who is coming shows ATTENDANCE, not a generic
// reply — the Case 2 (meeting) work, Phase 3 (2026-09-10). `api/board.ts`'s row now carries an
// `attendance` tally for a `meeting` / `asksAttendance` notice, and `web/src/incidentRow.ts`'s
// Response column reads "N of M coming · X attending · Y sending someone · Z silent" instead of
// the generic reply words; `compareRows` sorts an unanswered gathering above a settled one.
// Every emergency row is unchanged. `web/src/main.ts` + `incidentRow.ts` moved, so the bump.

// v250: the post-incident report gains a "Who is coming" section — the Case 2 (meeting) work,
// Phase 4 (2026-09-10). `domain/report.ts` `buildReport` now returns an `attendance` roll-up
// (null for every emergency, a plain notice and `schedule`); `renderReport` (plain text) and
// `web/src/report.ts` (the downloaded page) print a "Who is coming" section — N of M coming and
// the attending / sending someone / not attending / silent split — in place of a filed page
// that carried a recipient list and no count of it. The "Nobody responded to this" gap is
// replaced by "Nobody said whether they were coming" for a notice that asked. `report.js` is in
// the LAZY group — no shell bytes — but it is hashed into the shell digest, so the bump.

// v251: the incident drawer's "Who was told" panel heads its recipients with the GROUP a
// dispatch expanded — Case 3, Phase 2 (2026-09-10). `expand()` still dissolves a ticked group
// into loose recipients at send; the server now reads the group's name back off
// `dispatched.payload.fromGroups` and sends it on the detail payload as `recipientGroups`, and
// `web/src/dispatch.ts` `renderWhoWasTold` groups its rows under "<group> — N of M responded",
// anybody chosen by hand beneath. Display only — no group entity in `IncidentState`, not one
// tally changed. An incident dispatched only by hand, and an older server, draw the flat list
// exactly as before. `web/src/main.ts` + `dispatch.ts` + `dispatch.css` moved, so the bump.

// v252: the Record row's response breakdown groups its lines under the group a dispatch
// expanded — Case 3, Phase 3 (2026-09-10). `api/board.ts` tags each `response.breakdown` entry
// with the group name it came from (read off `dispatched.payload.fromGroups`, `null` for a
// hand-picked recipient), and `web/src/incidentRow.ts`'s disclosure draws a heading wherever it
// changes — the group's name over its members, "Individually notified" over the rest. Drawn
// only when a dispatch actually used a group; otherwise not one heading and the list is
// unchanged. `web/src/incidentRow.ts` + `index.html` (`.responsegroup`) moved, so the bump.

// v253: the post-incident report's "Who was told" section groups its recipients under the group
// a dispatch expanded — Case 3, Phase 4 (2026-09-10). `domain/report.ts` `recipients()` tags
// each row with the group name (read off `dispatched.payload.fromGroups`, `null` for a
// hand-picked recipient); the plain-text `renderReport` and `web/src/report.ts` (the downloaded
// page) head the list with it — the group's name over its members, "Individually notified" over
// the rest — and only when a dispatch used one. `report.js` / `report.css` are LAZY — no shell
// bytes — but both are hashed into the shell digest, so the bump.

// v254: the incident drawer's officer responses stop reading as small print — the owner's own
// note (2026-09-11). The section headings ("The alert we sent", "The response we received",
// "Status by recipient", "Who is coming") go from `--t1` slate to `--t2` `--ink` so they land as
// headings, not captions; the verbatim quote blocks (`.d-msg`) gain weight and the incoming
// reply's left edge turns `--ok` green (burnt-orange `--unheld` when every office declined); and
// "Status by recipient"'s per-recipient reply (`.tsaid`) — `--t2` slate italic, the one line the
// panel exists for — becomes `--t3` `--w2` upright, `--ok` for an owning reply and `--unheld` for
// a declined one, told apart by colour as well as by the words (INV-04 holds: the quote is always
// there). `index.html` + `dispatch.css` + `web/src/main.ts` moved, so `shellVersion.test.ts`
// requires the bump.

// v257: the incident drawer's top pill says "Responded" instead of "In progress" for the
// `responded` stage — 2026-09-19, the owner's own read of a real handset after a meeting's
// `Attending` tap. The word matched nowhere else in the product: the dashboard's own counters
// (`panels.ts`) and the Board strip both already say "Responded" for this stage, and the
// drawer alone used older wording for the identical fact. `web/src/main.ts` moved, so the bump.
// v258: Bajaur's `member` accounts (ADR-0038) — the shell sends a member to `/activities.html`,
// a page of its own the service worker never answers with the shell; storage keys and the
// session cookie are Bajaur's own. `main.ts` and `index.html` moved, so the bump.
// v259: Bajaur B2/B3 (ADR-0038) — Activities permissions in the overrides editor, "Post" and a
// `member` default on Add account, and "Give login" in the contact drawer. Settings and the
// office bundle moved, so the bump.
// v260: Bajaur C1 (ADR-0039) — "Activities department" on Add account. Settings moved, so the
// bump. (`/activities.html` and its script are not the shell and are never cached by it.)
// v261: an "Activities" button in the shell's navigation, for every signed-in account — the
// control room had no way to reach `/activities.html`. `index.html` and `main.ts` moved.
// v262: the "Install this app" banner (`install.ts`, Bajaur PLAN §4 A), and the Directory and
// Groups cards built with `textContent` instead of unescaped `innerHTML` — that fix (923ea6d)
// moved `admin.ts` without this bump, so it reaches cached browsers only now.
// v263: Bajaur C3 (ADR-0039) — `/activities` joins NEVER_CACHE. Since C1 every Activities read
// went through the cache-first branch: an officer posted, and the list that followed was the
// one from before the post (found by the C3 browser test). Videos made it worse — a byte-range
// request cannot be answered from this cache at all.
// v264: Bajaur E1 (ADR-0041) — "Give login" in the contact drawer takes an Activities department.
// `admin.ts` moved, so the bump.
// v265: Bajaur E2 (ADR-0041 §9) — the Officers tab on `/activities.html`; Departments keeps only
// the folder list. `activities.html` and its script moved, so the bump.
// v266: Bajaur E3 — fewer Activities tabs: Departments under Officers, Log and Recycle bin under
// History, Pending shows its count. With it, E4's start (ADR-0042): the Urdu switch on both pages
// and `ur.json`. `activities.html`, `index.html` and their scripts moved, so the bump.
// v267: Bajaur E4b (ADR-0042) — the control room's words in `ur.json`, dates in Urdu on an Urdu
// page, dialogs translated, right-to-left fixes (ticker direction, dashboard overflow).
// v268: Bajaur E4c (ADR-0042) — the How-to-use guide in Urdu, paragraph by paragraph; every
// stylesheet's left/right margins, paddings, borders and alignment made logical for right-to-left.
// v269: Bajaur E5 (ADR-0043) — "Give login" sends a sign-in link; the set-password page;
// `/set-password` never cached. `admin.ts`, `activities.ts`, `office.css` and `ur.json` moved.
// v270: the administration tick gets its control in the contact drawer. `admin.ts` moved.
// v271: "Remove this video" on an Activities video that could not be used. `activities.*` moved.
const CACHE = 'dnc-shell-v271';

// v222: "The same period, as a file" moved off the Record onto Administration's History tab
// (2026-09-05), at the owner's request — it no longer belongs on the day-to-day working screen.
// `index.html` loses `#boardReports` (the acknowledgements/resolutions/daily-report/daily-CSV
// links) and the Download view is left holding only `#boardExport` (the fixed 30-day export,
// unrelated to the shared range); `main.ts`'s reportFrom/reportTo block no longer retargets
// those anchors, only defaults the pair for Rows and Summary. `admin.ts` gained
// `buildPeriodFiles()`, drawn into the History tab with its own From/To (`#historyReportFrom`
// / `#historyReportTo`, deliberately not `#reportFrom`/`#reportTo` — a different screen
// reached from a different nav, not a third reader of the Record's pair); `office.css` gained
// `#historyReports` styling carried over from the rules `#boardReports` had.

// v221: a message on its own dnc_response_<category> template stops repeating the kind its own
// header already names, and "Where is it?" is back on the report form — this time actually read
// (2026-09-05). `security`/`flood`/`other`/`alert`/`advisory`/`order`'s templates open "Deputy
// Commissioner Bajaur — Flood Alert" (etc.) before `{{1}}`, and `{{1}}` was still repeating it
// ("ALERT · high" under "District Alert"); `messageFor` now drops the kind prefix and category
// segment when `ops/whatsappTemplate.ts`'s new `namesKindInHeader` says the header already said
// it. Separately, `#place` — removed earlier today because its text went nowhere a human could
// read it back — is restored below the button (M0-36), and this time `locationLine` (`domain/
// communications.ts`) puts it, or a map link built from the device's own GPS fix, onto the
// WhatsApp message and the Record row's expanded title. `index.html` + `main.ts` + `location.ts`.
// The map-link half of this is reverted in v223 above.

// v220: v219 reverted (2026-09-05). The owner saw the empty-panel-hide/last-row-widen change
// live and did not like the changed look of the dashboard — asked for the previous one back,
// no further dispute investigated. `index.html` + `dashboard.ts` are back to their pre-v219
// content; this bump exists only so a browser holding the v219 cache refetches the old shell.

// v219: an empty dashboard panel hides itself; the last row widens to close the gap
// (2026-09-05, reverted the same day — see v220 above). `importantEmergencies`,
// `routineEmergencies`, `alerts` and `presence` hid themselves when they had nothing to show,
// the same mechanism `condition` has used since M6-30; `services`/`utilities`/`keys`/
// `situation`/`weather`/`stillRunning`/`facts` deliberately did not (ADR-0005).
// `balanceLastRow()` widened the trailing panel to close the gap a hidden one left in the
// grid's last row. `index.html` + `dashboard.ts`.

// v218: the merged report grid's placeholder category stops printing as "Other" (2026-09-05).
// Alert, Advisory, Order, Meeting, Schedule and Information tiles all write category `'other'`
// because none of them ever asks the operator to classify anything — only the seven emergency
// tiles have a real one. The Record row's `.cat` badge and the detail drawer's eyebrow/heading now
// show the kind's own label (`hasCategory` in `domain/communications.ts`) instead of "Other" when
// the category carries no information; an emergency's own genuine "Other" tile is unaffected.
// `incidentRow.ts` + `main.ts`.

// v217: "Where is it?" and "Anything else?" removed from the intake form (2026-09-05). Neither
// field's own text was ever read back anywhere a human could see it. `index.html` loses `#place`,
// `#detail` and the now-pointless `#addDetail` button; `main.ts`'s `description` is `what` alone,
// `location` keeps only the silent GPS-fix layer.

// v100: the Urdu headlines get Nastaliq (2026-08-19). `index.html` gained one `@font-face` and
// two rules; the face itself is `web/fonts/noto-nastaliq-urdu-600.woff2` and is deliberately NOT
// in SHELL — 161 KB precached is 161 KB a field officer downloads at a scene for a panel that
// only exists on the dashboard. The generic handler holds it under this version string, exactly
// as it holds `help.css`, which is also why a face swapped later needs a bump like this one.

// v99: the Pakistan panel is a ticker (2026-08-19). Headlines are LINKS now, in a new tab, and
// the list is Urdu then English scrolling bottom to top. `index.html` gained the track's rules
// and a fixed window height; `dashboard.ts` builds the doubled track. v98 is its own commit, so
// this could not be folded into it — the rule this file already carries about a version that has
// left the laptop.

// v98: the weather panel draws the weather (2026-08-19). `index.html` gained the `.wxscene`
// element and four rules; the engine itself is in the LAZY `dashboard.js` and is not shell bytes,
// but the markup and the CSS are — and a browser holding v97 would keep a panel whose scene
// element does not exist, which is a canvas mounted into nothing.

// v108: weather and the headlines are ONE panel on the wall (2026-08-19, the owner's decision).
// `dashboard.ts` MOVES the two existing sections into the `outside` frame rather than drawing
// anything — nothing is redrawn and no element id moved, which is the only reason the canvas and
// the ticker survive being reparented.
// ⚠️ The frame's MARKUP and CSS reached the shell one commit early, swept into `cdb7ab9` by a
// broad `git add` while they were still uncommitted. They were inert there — the section ships
// `hidden` and nothing unhid it — but the digest for v107 already describes them, which is why
// this bump is for the client half alone.

const SHELL = ['/', '/index.html', '/app.js', '/manifest.webmanifest'];

/**
 * Paths that must **never** be served from cache, under any circumstances.
 *
 * `/sync` — a cached response is not a stale page. It is a client being told its emergency
 * was accepted when it was not. The outbox would then delete the entry (it releases only
 * what the server confirms it holds), and the report would be gone. INV-01 violated by a
 * caching layer, silently, with no error anywhere.
 *
 * `/auth` — `/auth/me` is a GET, so it would otherwise be cached like any other. A cached
 * identity means a handset showing the previous holder as signed in after a shift change,
 * and every report captured on it attributed to someone who has gone home. On a shared
 * device that is not a staleness bug, it is a false record.
 *
 * `/incidents` — `GET /incidents/:id` is the incident's live state and its history. A
 * cached copy is a screen showing an emergency as unacknowledged when someone is already
 * on the way, or as open when it was closed an hour ago. That is INV-02 exactly: stale
 * data rendered as current, and here it would be rendered on the screen an operator uses
 * to decide whether to send anyone.
 *
 * Network-only. If the network is down the request fails, which is correct: the outbox
 * treats a failed push as "still queued" and tries again.
 */
const NEVER_CACHE = [
  '/sync',
  '/health',
  '/auth',
  '/incidents',
  /**
   * The board's doorbell (`/board/live`, M8) — an SSE connection that never completes for as
   * long as it is open.
   *
   * Left off this list, the generic branch below would still try to serve it: `cache.put()`
   * only resolves once it has read the response body to the end, and this response has no end
   * while the tab is open. `event.respondWith()` would then never settle, and the page's
   * `EventSource` would sit waiting on a connection the service worker was quietly never going
   * to deliver — no error anywhere, on any screen. The same class of failure as `/sync` being
   * cacheable, found by reading this file rather than by a test noticing a hang.
   */
  '/board/live',
  /**
   * The sign-in link's page (ADR-0043). Each address carries a single-use token; a copy kept in
   * a cache is a page that says "choose your password" for a link that has already been used.
   */
  '/set-password',
  '/admin',
  '/roster',
  '/fleet',
  /**
   * `/dashboard` and `/status` — added after they shipped without being here (M4).
   *
   * Both are live district state. Cached, the dashboard shows counts and a weather reading
   * from whenever the page was last online while its own "as of" clock ticks forward — the
   * exact stale-but-confident failure this whole feature was built to prevent (INV-02).
   *
   * `/status` was worse. An officer set a service's owning department, the write succeeded,
   * and the screen kept showing "nobody assigned" — because the reload after the write was
   * answered from cache. It looked like a save that silently did nothing, which is the one
   * outcome that makes people stop trusting a form.
   */
  '/dashboard',
  '/status',
  '/contacts',
  /**
   * `/search` and `/export` — here from the day they shipped, unlike the two above.
   *
   * A cached search is the same failure as a cached board, arriving by a route that looks
   * harmless: somebody searches for an incident, gets last week's answer, and reads it as the
   * state of the district today. Worse, a search is often the *last* look somebody takes
   * before writing a post-incident report, so a stale one becomes a stale document.
   *
   * The export is the same argument with a longer life. A cached CSV is a stale file that
   * leaves the building, gets emailed on, and is read months later by somebody with no way to
   * know when it was actually true.
   */
  '/search',
  '/export',
  /**
   * `/settings` — the Settings panel's reads (ADR-0032 phase 3), and here from the day it
   * shipped, unlike `/dashboard` and `/status` which were not.
   *
   * The panel re-reads `/settings/accounts` after every account change to redraw the table. A
   * cached GET answers the reload with the list from before the change — so an administrator
   * adds an account, the POST succeeds, and the row never appears: a save that looks like it
   * silently did nothing, which is the exact `/status` failure the note above records. The
   * access log and the security policy are live state for the same reason.
   */
  '/settings',
  /**
   * `/activities` — Bajaur's Activities (ADR-0039), and missing from here from C1 until C3.
   *
   * The `/settings` failure again: the page re-reads `/activities/posts` after a post, and the
   * cached answer was the list from before it — a post that looked lost. And the photos and
   * videos are behind a permission and a 30-day delete: a cached copy outlives both. A video is
   * also fetched in byte ranges, which this cache cannot answer. The browser's own HTTP cache
   * still keeps a photo or video with its ETag (`private, no-cache`), so nothing is
   * downloaded twice.
   */
  '/activities',
];

function isNeverCache(url: URL): boolean {
  return NEVER_CACHE.some(
    (p) =>
      url.pathname === p || url.pathname.startsWith(`${p}/`) || url.pathname.startsWith(`${p}?`),
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(SHELL);
      // Take over immediately. An operator should not have to close every tab to get a fix.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Same-origin only. Never interpose on anything else.
  if (url.origin !== self.location.origin) return;

  // A write never comes out of a cache, and a POSTed form navigation is still a write.
  if (request.method !== 'GET') return;

  /**
   * Paths on this origin that are **not the application** and must never be answered with its
   * shell.
   *
   * `/privacy`, `/terms` and `/data-deletion` are served by Caddy from files, not by the app
   * (see `installer/cloud/privacy.html`, `terms.html` and `data-deletion.html`). Without this the
   * navigation branch below hands them `/index.html` from the cache and an officer clicking the
   * district's own privacy link gets the report screen — which is what happened the day the page
   * went up, on the first browser that had ever opened the app. Meta never saw it, because a
   * crawler has no service worker; only real people did.
   *
   * **Every path Caddy serves from `/var/www/dnc-legal` belongs on this list**, and the two are
   * edited together or not at all: a `handle` block added to the Caddyfile without a line here
   * produces a page that is provably correct over `curl` and broken for every human in the
   * district, which is the hardest shape of bug to be told about.
   *
   * The offline argument that justifies the shell fallback does not apply here: this is a
   * static legal document, and a person with no connection has nothing to read anyway. Failing
   * is the honest outcome.
   */
  // `/activities.html` is the member page (ADR-0038): a page of its own, never the shell.
  const NOT_THE_APP = ['/privacy', '/terms', '/data-deletion', '/activities.html'];

  /**
   * **The same rule, for the two paths that carry a token — and this is the one that broke the
   * acknowledge button on 2026-08-14.**
   *
   * A prefix list rather than the exact list above, because the token is part of the path:
   * `/ack/<token>` and `/file/<token>` are matched by `server.ts` with a regular expression,
   * so there is no fixed string to put in `NOT_THE_APP`.
   *
   * **What happened, and it is the third instance of this exact fault.** The template's URL
   * button is `https://dnc.example.com/ack/{{1}}`. Tapping it is a **navigation**, so the
   * branch below answered it with the cached `/index.html` — the officer got the application's
   * report screen instead of the acknowledge page, and **nothing was recorded**: no
   * `acknowledged` event, the obligation still unmet on the board, and the token not even
   * spent. The owner found it by tapping the button on the first real message this district
   * ever sent.
   *
   * **Both halves of that failure are this project's worst signature: the action succeeds.**
   * The button works, a page opens, the page looks like the district's own software, and the
   * only way to know is to read the database afterwards.
   *
   * **It could only ever hit somebody who has opened the app**, because a browser with no
   * service worker goes straight to the server — which is why `curl` proves nothing here, why
   * the officers this feature is *for* (ADR-0018: they never sign in, they never open it) were
   * unaffected, and why it was the control room that met it first.
   *
   * `/file/` is on this list for the same reason and was equally broken: an attachment reaches
   * a handset as a single-use link (M9-18), and that link is a navigation too.
   *
   * The offline argument does not apply to either. Both are single-use, server-side redemptions
   * — there is nothing a cache could correctly answer, and answering *anything* from a cache is
   * how a tap gets swallowed.
   */
  const NOT_THE_APP_PREFIXES = ['/ack/', '/file/'];

  if (NOT_THE_APP.includes(url.pathname)) return;
  if (NOT_THE_APP_PREFIXES.some((p) => url.pathname.startsWith(p))) return;

  // A navigation must always resolve to the shell, even offline. This is the line that
  // makes the app openable during a shutdown.
  //
  // **This is checked before `isNeverCache`, and the order is load-bearing.** Adding
  // `/incidents` to the never-cache list broke exactly this: an operator opening the app at
  // `/incidents/<id>` during an outage got ERR_INTERNET_DISCONNECTED, because the path was
  // network-only and a navigation is a request like any other. The two cases are genuinely
  // different and the URL alone does not distinguish them — `GET /incidents/:id` as a data
  // fetch must never be served stale (INV-02), while the same URL as a *navigation* is a
  // person opening the app and must always resolve. The shell it gets is not incident data;
  // it fetches that fresh, or shows that it cannot.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cached = await caches.match('/index.html');
        if (cached) return cached;
        return fetch(request);
      })(),
    );
    return;
  }

  if (isNeverCache(url)) {
    // Explicitly not handled — straight to the network, and allowed to fail.
    return;
  }

  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached) {
        // Refresh in the background so the next launch is current, without ever making
        // the operator wait on the network.
        void (async () => {
          try {
            const fresh = await fetch(request);
            if (fresh.ok) await (await caches.open(CACHE)).put(request, fresh.clone());
          } catch {
            // Offline. The cached copy already served; nothing to do.
          }
        })();
        return cached;
      }

      const response = await fetch(request);
      if (response.ok) await (await caches.open(CACHE)).put(request, response.clone());
      return response;
    })(),
  );
});

export {};
