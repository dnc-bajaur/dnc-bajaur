# Open Questions

**Everything domain-specific in this repository is currently assumption, not verified
fact.** The architecture documents are sound as engineering; the claims they make about
Bajaur's departments, systems, and procedures are not yet sourced.

Do not build past a **blocking** question by guessing. Raise it.

**Status legend:** `BLOCKING` — work stops · `HIGH` — decide before the milestone that
needs it · `OPEN` — track, resolve when convenient · `RESOLVED` — with evidence and date.

> **These are design questions. They are no longer the urgent ones.** As of 2026-08-13 the
> system is live at `dnc.example.com` and the two things actually holding the district back are
> **operational**, not architectural, and live in `backlog/for-the-owner.md`:
>
> - ~~**O-12 — the WhatsApp template name.**~~ **CLOSED.** It was closed once on 2026-08-14 when
>   `.env` was pointed at `district_message_v2`, and the district has been sending ever since.
>   **As of 2026-08-18 the live pair is `district_message_v3` and `district_message_img_v2`** —
>   the owner asked for the 105-character closing sentence to be removed, that sentence lives
>   inside the approved template at Meta and not in this repository, so it took two new
>   submissions and a switch. `npm run doctor` is green on both against the district's own
>   account. **The lesson the question was raised for still stands**: a wrong name means Meta
>   refuses every send with nothing on any screen saying so, which is why `doctor` compares what
>   Meta approved against what the software sends rather than trusting either.
> - **M0-38 — the restore drill.** The off-site backup has never been opened by a human. Sheet
>   written at `backlog/restore-drill.md`; it needs **two people and a clock**, which is why no
>   amount of engineering closes it.

---

## Blocking

### Q-04 · What is the legal basis for holding citizen emergency data? `RESOLVED 2026-08-02`
**Answer: the district administration is legally empowered to record, hold, act on and
respond to any emergency in the district — for the public and from the public.** Source:
project owner, 2026-08-02. **The pilot is no longer blocked on this.**

Two things the answer does not cover, and they are engineering obligations rather than legal
ones, so they stay ours: **retention** (how long reporter details are kept — see Q-11 for
media) and **access** (who may read reporter contact details, which the authority model
governs). Being permitted to hold data is not the same as having decided how long, or who
may look.

---

## High

### Q-06 · What are the real acknowledgement SLA targets? `RESOLVED AND BUILT 2026-08-02`
**Answer: the DC and AC Headquarter offices set them inside the software.** They are an
internal rule the administration owns, not a number to be gathered and hard-coded. Source:
project owner, 2026-08-02.

**Built the same day (M1a-04).** Migration 0007 seeds `PLACEHOLDER_SLA` into a `sla_target`
table and the table becomes the authority from that moment. Targets are set per department
and per severity from the Deadlines tab of the administration console; the board and the
escalation job both read them; every change is recorded in `config_event` with who made it.
`unknown` is settable too — not a level (ADR-0009), but the deadline is precisely where the
urgency of an unassessed report now lives.

The board no longer renders a guess as though it were the district's rule.

**Two bugs found while closing this, both of which would have been silent:** a department
given a *longer* deadline than the district kept the district's shorter one, and changing an
existing deadline failed every time while setting a new one worked. Both are pinned by tests.

### Q-07 · Which notification channels are actually reliable in Bajaur? `RESOLVED 2026-08-02`
**Answer: WhatsApp first; if WhatsApp does not reach them, redirect to a direct phone call;
and let the user route a given notification to another channel when they need to.** Source:
project owner, 2026-08-02. See **ADR-0012**.

The policy is a **ladder**, held as configuration on the administrative dashboards: WhatsApp →
voice call → SMS, with the in-app inbox always in parallel. An exhausted ladder is surfaced as
undelivered, never as delivered (ADR-0005).

The one thing added on top of the owner's answer is a rung below it. There are **two different
internets** in play: the recipient's — WhatsApp needs their handset to have data, and falling
back to a call handles that exactly as described — and the **server's**, which must reach Meta
and the telephony provider to send anything at all. ADR-0011 puts the server in the DC office
so that a district internet failure does not stop work, so a notification ladder that goes
dark in that same failure would be incoherent. A **GSM modem or SIM gateway** attached to the
server sends SMS and places calls over the mobile network with no internet on either end, and
is recommended as the last rung.

Still outstanding, and it is procurement rather than engineering: a Meta business account with
**pre-approved templates** (longest lead time — alerts are business-initiated, so Meta must
approve the wording in advance), an SMS gateway account, a telephony provider, and the modem.
Adapters are built against fakes in the meantime.

### Q-08 · Does the Place gazetteer exist anywhere already? `DROPPED 2026-08-02`
**Answer: do not go into that depth.** Source: project owner, 2026-08-02.

Location capture already works without it — GPS when available, free text otherwise, with a
record of which layers actually produced something (M0-48). A gazetteer would add structured
places on top of that; the district does not want the effort spent there now.

Revisit only if operators find free-text place names unusable in practice.

### Q-09 · Urdu, Pashto, or both? `HIGH`

Affects translation scope and whether bidirectional layout is required from the start.
Should be answered by asking actual operators, not assumed.

**Needed for:** M1 UI work.

### Q-10 · What is the escalation path above the district? `CLOSED — OUT OF SCOPE 2026-08-02`
**There is nothing above the district administration in this system.** ADR-0010 makes the
ladder two rungs: department → DC Office / AC Headquarter. An emergency that reaches the top
and is still unacknowledged is surfaced as *needs a human, urgently*, which is already built.

Reopen only if the district asks for provincial notification.

---

## Open

### Q-11 · Media retention policy `OPEN`
Photos and video from incidents. Storage cost and privacy both argue for a shorter
retention than the incident record itself. Needs a decision, not a default.

### Q-12 · Radio integration `OPEN`
Whether radio traffic can feed the system directly at L3/L4, or whether it stays
operator-transcribed. Probably the latter for v1.

### Q-13 · Public-facing reporting `OPEN`
Whether citizens report directly, or only through departments and the control room. Large
scope and trust implications. Explicitly out of MVP scope until decided.

### Q-14 · Existing officer and contact directories `PARTIALLY ANSWERED 2026-08-02` · `HALF BUILT 2026-08-13`
**A list exists and the district supplied it** — 81 posts across ~79 offices, with 43
contact numbers. Loaded via `db/seed/directory.json` (gitignored). More to follow, so the
loader is idempotent.

The remaining half of the question is unanswered and is the expensive half: **who keeps it
current?** A directory is wrong within months of nobody owning it, and this system routes
emergencies by it. Still needs an owner before the pilot.

**What M9-23/24 changed, and what it did not.** The recipient picker now *counts who cannot be
reached*, and an administrator can add a missing officer or department **from that screen** — at
the moment they discover the gap, mid-call, instead of four navigations away in the console. The
form also offers the department's **empty posts**, so the vacancy the picker is reporting can be
closed by the same act.

That removes the excuse, not the owner. The directory is now maintainable **exactly where its
gaps surface**, which is the best a piece of software can do about this question. **Somebody in
the district still has to be the person who does it**, and naming them is still open.

### Q-18 · How is Bajaur actually organised? `RESOLVED 2026-08-02`
**Answer: two administrative offices, and everything else reports to them.** The DC Office
and the AC Headquarter Bajaur Office are responsible for the whole district. See **ADR-0010**.

This also answers the two sub-questions:
- **Grouping** — irrelevant in the way it was asked. There are not layers of departments;
  there are two administrative offices and a flat set of departments beneath them, which the
  two offices create and edit themselves.
- **Which are emergency responders** — decided by **routing signals** the administration sets
  per department, not by anything the system infers. Anything unmatched goes to both
  administrative dashboards marked **unassigned**, for a human to assign.

**What it replaced.** The question asked which offices are posts inside larger
departments, what tier each seat is, and which of the ~79 respond to emergencies. The first
two dissolve under ADR-0010 — there is no deep hierarchy to discover — and the third is
answered by configuration rather than by a list.

### Q-19 · Two officers, one mobile number `RESOLVED 2026-08-02`
**Answer: keep both.** `03000000171` genuinely covers `ADC (Finance & Planning) — Kamran
Aziz` and `TMA Bajaur — Kamran Ali`. Source: project owner, 2026-08-02.

An office handset covering two posts is ordinary here, so the schema was wrong rather than
the data. Migration 0006 moves phone uniqueness to where it is load-bearing: **a person who
can authenticate must own their number; a directory contact may share one.** `login()` now
considers only rows with a password hash, so "who is signing in?" keeps exactly one answer.

The pairing is still surfaced as a **note** on every load. It is real, and it is also
precisely the shape a mistyped digit takes — nothing in the data distinguishes them.

Two smaller ones from the same list, both **accepted as given** by the owner on the same
date:
- `AAC Barang` carries the designation `AAC Salarzai`. Loaded verbatim. It is the district's
  document, and correcting it here would put a change into the roster that nobody in Bajaur
  made.
- **Rescue 1122 has no contact number.** Noor Rahman Khan is named as District Emergency
  Officer with no number, so the post is loaded **vacant**. Worth restating because it is not
  a small gap: Rescue 1122 is the entire subject of M1, notifications reach a seat through
  its holder, and a vacant seat is exactly what the escalation ladder is designed to surface
  rather than swallow. **M1 cannot demonstrate a full incident lifecycle until this number
  exists.**

### Q-15 · Secondary control room location `OPEN`
`00-thesis.md` flags the control room as a single point of failure. Where the secondary
site is, and who has access, needs an answer before go-live.

### Q-16 · Should severity have an explicit `unknown`? `RESOLVED 2026-08-02`
**Answer: yes — as a value, never as a level.** See `ADR-0009`.

Decided when the central board was built, which is exactly when it stopped being
theoretical: the old behaviour assumed `high`, and a board would have rendered that as
somebody's assessment. Aggregates now report two numbers — worst assessed, and how many are
unassessed — and neither is folded into the other. The urgency the old guess expressed moved
to the SLA target for `unknown`, where it does not lie on a screen.

### Q-17 · May a department emit `overridden` on its own field? `OPEN`
The policy table makes the owning department allowed on its own fields, so
`POST /incidents/:id/override` succeeds for the owner as well as the district. It is fully
attributable — `actorSeatId` is the department's own seat, so nobody can manufacture the
appearance of a district decision — but `overridden` is meant to record *someone else's*
authority being exercised, and a department revising its own call should arguably triage
again instead.

Pinned by a test as current behaviour so that changing it is deliberate. Low urgency, real.

---

## Resolved

### Q-03 · Who maintains this after handover? `RESOLVED 2026-08-01`
### Q-05 · Who owns this system, formally? `RESOLVED 2026-08-01`

**Answer: the district administration — the DC office and/or the AC Headquarter office.**
Source: project owner, 2026-08-01.

Both questions have the same answer, so they are resolved together.

This is a good answer for a reason worth naming: it is an **office, not a person**. Offices
survive transfers, which is precisely the logic behind `ADR-0004`. "The DC office owns
this" remains true after every posting order; "Officer X owns this" would not.

**Consequences**
- `05-stack.md` is **confirmed**, not merely proposed. DC/AC office IT is exactly the
  small-team profile the stack was chosen for, so the answer validates the existing
  choice rather than changing it. The dependency rule in that document — *who restarts
  this when it fails, and how do they know it failed* — now has an addressee.
- The authority model can be finalised: the DC seat is the district-tier authority and the
  break-glass holder.
- M0 unblocked. Local PostgreSQL 17 provisioned; see `05-stack.md`.

**Deliberately carried forward rather than treated as answered**
Two practical items sit underneath the organisational answer, and both belong to M5
handover rather than to the build:
- Whether a **named technical person** exists today, or the office needs to designate one.
  The office owning it and someone being able to restore a backup at 02:00 are different
  facts.
- **Hosting budget and its source**, which decides cloud VM versus on-premise in the DC
  office. The system is being built so either works, so this is a deployment-time fork,
  not a blocker now.

### Q-01 · Does Rescue 1122 already run a dispatch system? `RESOLVED 2026-08-01`

**Answer: yes, several departments run government-issued systems — and it does not matter.**
Source: project owner, 2026-08-01.

The district's explicit intent is a platform they run **independently of government-issued
software**, for their own efficiency and their own control. Integration is therefore
**not a requirement and not a goal.** No API coupling, no dependency on a provincial or
federal system's availability, no shared schema.

**Consequences**
- M1 is unblocked. Build Rescue 1122's workspace on our own model.
- Do not spend effort discovering, negotiating, or reverse-engineering external interfaces.
- **New risk introduced, and it is the serious one:** departments already using another
  system now face double entry. That is the single most likely cause of adoption failure —
  it does not make this system wrong, it makes speed and usefulness non-negotiable. Two
  mitigations, both already in the plan:
  1. The 15-second rapid-intake budget (`00-thesis.md`) is now a hard requirement, not an
     aspiration. If this system is slower than what they already tolerate, it loses.
  2. **Report export** (see Q-02) — the system produces the formats departments must submit
     upward, so it *replaces* work rather than adding it.
- Bypass rate (`backlog/milestones.md`) becomes even more important as the adoption canary.

### Q-02 · What must each department already report upward? `RESOLVED 2026-08-01`

**Answer: still worth knowing — but as an export target, not an integration target.**
Source: project owner, 2026-08-01, following from Q-01.

Departments retain their existing upward reporting obligations. This platform does not
connect to those systems, but it **can generate the formats they need to submit**, as
files, on demand. That is export, not integration: no coupling, no dependency, no loss of
independence — and it turns the platform from extra work into saved work.

**Consequences**
- M2 no longer blocked on interface discovery.
- Collect required report *formats* per department during M1/M2 onboarding — a lightweight
  task, not a research phase.
- Report export becomes a named capability (see `07-capabilities.md`, group 9).

---

When resolving: move the question here, state the answer, cite the source and date, and
update every document the answer affects. Log it in `CHANGELOG.md`.
