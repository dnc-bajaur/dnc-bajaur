# ADR-0022 — The control room assigns. Nothing routes itself.

**Status:** Accepted · 2026-08-20
**Decided by:** the project owner, on the district's behalf, on the control room's own account of
using the system.
**Amends:** [ADR-0010](./ADR-0010-two-rung-ladder.md) — its *"routing is configuration, not inference"*
clause, and only that clause.
**Completes:** [ADR-0016](./ADR-0016-control-room-first.md), which made a human routing by hand
the design on 2026-08-05 and left the automatic mechanism running underneath it.
**Removes:** `domain/routing.ts`, the `routing_signal` table, the signal endpoints on `/admin`,
the signal editor on the console, and the automatic pass at intake and on `/sync`.

## ⚠️ CORRECTED 2026-08-20, the same day, after the deploy

**One sentence in the Context below is false, and it is the sentence the whole record leans on.**
It says the district never wrote a single signal. **Bajaur had one**: a `category` signal reading
**`fire incident` → Assistant Commissioner Bajaur**, created **2026-08-17 15:11 UTC** by a real
seat, three days before this decision.

It is left in place rather than rewritten, because an ADR is not edited — and because *how* it
came to be written is the more useful record. It came from two stale sources agreeing with each
other: a comment in `web/src/dispatch.ts`, and **R-04**, open since 2026-08-02. Both were true
when written, both were **descriptions** of the database, and neither is a query. `select count(*)
from routing_signal` against the live box would have settled it in two seconds.

**What this changes about the decision: nothing.** The owner was asked once the signal was found,
mid-outage, and chose to retire it and go forward rather than roll back. It is retired and its
whole content — pattern, kind, department, reason — is preserved in `config_event`, which
outlives the table it described.

**What it changes about the deploy: everything.** Migration 0031's guard fired exactly as designed
and refused to drop configuration nobody had decided about — but migrations run at boot, so
refusing meant the service could not start, and **Bajaur served 502 for 34 minutes**. That is
**O-40** in `backlog/for-the-owner.md`: a check that can only speak by killing the service belongs
in a preflight, not in a migration.

---

## Context

ADR-0010 gave each department **routing signals** — the categories and keywords it answers for —
and made the district administration responsible for writing them. A bazaar fire would reach
Rescue because somebody had once typed `fire` against Rescue, and nothing would ever be guessed:
an emergency matching no signal appeared on both administrative dashboards marked `unassigned`,
loudly, for a human to assign.

The mechanism was built, tested, and shipped on 2026-08-02. **The district never wrote a single
signal.** R-04 stayed open from that day to this one, `routing_signal` held zero live rows for the
entire life of the installation, and every emergency Bajaur has ever recorded was assigned by a
person in the control room.

Three days after ADR-0010, ADR-0016 made the control room the product: an alert arrives by
telephone, an operator types it, and the operator **chooses who should know**. That decision made
routing a second, redundant answer to a question a human was already answering — and the two were
never reconciled. The signals stayed in the schema, on the console, in the sweep and on the board.
The console told the district it had 154 departments with no routing signal. The sweep reported it
as a finding. The board counted every emergency as `unassigned` because, technically, a pass had
run and matched nothing.

**None of that was true in the way the screens said it.** Nothing was misconfigured. The district
had chosen a workflow and the software went on describing that choice as a gap.

The owner's account of why, in their words: the control room is **not a technical room**. A screen
that had already ticked something, for a reason written by somebody else, on a night when they
were the ones who knew where the fire was, did not help them — it confused them. They asked to
assign it themselves.

## Decision

**A `routed` event is written by a human, and only by a human.**

1. **There is no automatic routing pass.** Not at intake, not on `/sync`. An emergency is stored
   and it is held by nobody until the control room gives it to somebody.
2. **There are no routing signals.** The table is dropped (migration 0031), the endpoints are
   gone, and the console does not ask the district to configure where emergencies go.
3. **`unassigned` means what it says.** It was *"a routing pass ran and matched nothing"* — a
   configuration gap somebody was supposed to close. It is now *"nobody holds this yet"*,
   excluding resolved and closed. **It is a worklist, not a fault**, and it is the control room's
   own queue of what they have not got to.
4. **Suggestions survive; decisions do not.** `domain/learning.ts` still reads back who the
   district has actually told for this kind of emergency and pre-ticks them (M7-15…M7-18). Its
   base is the district's own record of itself, not a rule somebody typed, and it proposes and
   never decides. It is now the only thing that proposes anything.

## What ADR-0010 keeps

**Everything except the routing clause.** The two rungs stand. The DC Office and the AC
Headquarter Bajaur Office are still the authority for the whole district; they still create, edit
and retire departments, still add people and contact numbers, still set the SLA deadlines, and
still assign. An unacknowledged emergency still escalates from a department to them, and that is
still the top.

What they no longer do is **configure where an emergency goes**, because the answer to that was
always going to be given by the person on the telephone.

## Consequences

**Nothing is lost today, and that claim is checked rather than asserted.** Migration 0031 refuses
to run if `routing_signal` holds a live row, so a district that had quietly configured something
gets an error and a decision rather than a silent drop.

**The event log is untouched.** `routed` events written by the automatic pass — including the
empty ones — stay exactly as recorded, and the fold in `domain/incident.ts` still reads them
(INV-08). `config_event` keeps every `routing_signal` row it ever wrote, and its CHECK still names
that subject: outliving its subject is the entire point of a record, and *"who added the rule that
sent the bazaar fire to Irrigation"* must still have an answer in six months.

**The M1a gate is rewritten, not dropped.** It read *"an operator adds a department, gives it a
routing signal, and the next matching emergency reaches it"*. What M1a had to prove was that the
**registry** is live — that a department created on a screen is immediately usable, with no
developer and no restart. It is, and the gate now proves exactly that, with the control room
supplying the half that used to be automatic. The M1 gate's step 4 changed the same way, and the
provenance it asserts got **stronger**: a recorded seat where there used to be a null one.

**Three screens get quieter, and one lesson is carried forward.** The console loses the
`no routing signal` tag, chip, ordering and overview count; the sweep loses two findings; the
board's unassigned banner stops advising a fix that no longer exists. The lesson those changes
were already teaching — **a district shown red rows it can do nothing about learns to ignore red
rows** — is written into the ordering and the counters that replaced them: an edge colour and a
count are spent on the row somebody can act on tonight, or they are spent on nothing.

**What this costs, honestly.** For the five or six departments that take most of Bajaur's
emergencies, a signal would have saved a few seconds at 02:00 by pre-ticking the obvious answer.
That saving now has to be earned rather than configured: `learning.ts` gets there after five
dispatches of the same category, out of what the control room actually does. That is slower to
start and it cannot be wrong about a rule nobody remembers writing.

**If the district ever wants it back**, this record is the thing to read first — and the question
to put to them is not *"do you want routing"* but *"which five departments, and who will keep the
list current"*. R-04 was open for eighteen days because nobody owned that answer.

## How we would know this was wrong

Three signals, in the order they would appear.

1. **The unassigned queue stops emptying.** It is a worklist now, so the number that matters is
   not its size but its **age**: an emergency sitting unheld for longer than its acknowledgement
   deadline means the control room is the bottleneck, and a machine that pre-ticked the obvious
   answer would have helped. Watch the oldest unassigned incident of the day, not the count.
2. **The same department is assigned to the same category, by hand, every time.** That is a rule
   the district is executing from memory. `learning.ts` should be catching it after five — if it
   is catching it and the operator is still not taking the suggestion, the suggestion is wrong or
   invisible, and that is a bug in the panel rather than an argument for signals.
3. **An emergency reaches the wrong department more often than before.** Nothing predicted this
   and it would be the strongest possible evidence: it would mean the configured rule had been
   carrying knowledge the person on the telephone does not have.

**What would not count as evidence:** an operator saying it is slower. It is slower. That was
known, it was the district's call, and they made it against the thing they said was worse —
a screen that had already decided.
