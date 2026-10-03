# Open Questions — Bajaur

**Everything domain-specific about Bajaur is assumption until the owner confirms it.** The
engineering in this repository is sound; what it assumes about Bajaur's offices, officers and
procedures is not yet sourced. Unverified facts go here — never into code.

This file was rewritten on 2026-10-03. The version inherited from the original deployment
recorded **that** district's answers (its officers, its directory, its dates); those are not facts
about Bajaur and were removed. Where an answer became an architectural decision, the decision
lives on in its ADR and is listed below as such — it still needs Bajaur's confirmation where noted.

**Status legend:** `BLOCKING` — go-live stops · `HIGH` — decide before go-live · `OPEN` — track ·
`DECIDED (ADR)` — the software follows an ADR; confirm it suits Bajaur.

Facts the owner has been asked for (seal, numbers, domain…) are listed in `PLAN.md` §2, not here.
Questions raised while the work went on overnight are in `OWNER-QUESTIONS.md`.

---

## Blocking

### Q-04 · The legal basis for holding citizen emergency data `BLOCKING`
The original deployment's owner stated that the district administration may record, hold and act
on any emergency in the district. **Bajaur's DC office must confirm the same for Bajaur.** Even
then, two engineering questions stay ours: how long reporter details are kept, and who may read
them (the authority model governs the second).

### Q-03 / Q-05 · Who owns and maintains this system in Bajaur? `BLOCKING`
An office, not a person (offices survive transfers — ADR-0004). Proposed: the DC office. Still
needed: **a named technical person** who can restart the server and restore a backup at 02:00,
and **where it is hosted** (cloud VM or the DC office), which `PLAN.md` §3 waits on.

---

## High

### Q-06 · Acknowledgement deadlines `DECIDED (ADR)` — set them
The deadlines are set by the DC office inside the software (Administration → Deadlines), not
hard-coded. The shipped values are placeholders. **The DC office should set Bajaur's own before
go-live.**

### Q-07 · Which channels reach Bajaur's officers? `DECIDED (ADR-0012/0014)` — confirm
WhatsApp first from the district's own number; a phone call when WhatsApp does not reach someone;
nothing is ever shown as delivered when it was not. **Confirm this suits Bajaur's coverage**, and
whether an SMS gateway or GSM modem is wanted as a last rung (procurement, not engineering).

### Q-09 · Urdu, Pashto, or both? `HIGH` — partly answered
Urdu is built for the whole app (ADR-0042), wording awaiting the owner. **Is Pashto wanted too?**
Ask the officers who will use it. The same mechanism would carry it (a second word list).

### Q-14 · Bajaur's officer directory, and who keeps it current `HIGH`
The directory is loaded from `app/db/seed/directory.json` (gitignored; `PLAN.md` D-01) and edited
in the app. The expensive half: **who keeps it current?** A directory is wrong within months of
nobody owning it, and emergencies are routed by it. The app lets the control room add a missing
officer at the moment the gap shows, but somebody must own the list.

### Q-15 · A secondary control room `HIGH`
The control room is a single point of failure (`00-thesis.md`). Where the fallback is, and who
has access, needs an answer before go-live.

---

## Open

### Q-11 · Retention of incident media `OPEN`
Activities pictures and videos are deleted after 30 days (ADR-0039, decided). Incident evidence
(photos and files attached to emergencies) has no retention rule yet. Storage and privacy both
argue for one shorter than the incident record itself.

### Q-12 · Radio `OPEN`
Whether radio traffic feeds the system directly, or stays operator-transcribed. Probably the
latter.

### Q-13 · Citizens reporting directly `OPEN`
Out of scope until decided: large trust and moderation implications.

### Q-17 · May a department override its own field? `OPEN`
The policy table lets the owning department emit `overridden` on its own field. It is fully
attributed, but `overridden` is meant to record someone else's authority. Pinned by a test as
current behaviour so a change is deliberate. Low urgency.

### Q-19 · Two officers on one number `DECIDED (migration 0006)`
An office handset covering two posts is allowed for directory contacts; a person who signs in
must own their number. Such pairs are shown as a note on every directory load, because a shared
number and a mistyped digit look the same. Check Bajaur's list for them when it is loaded.

---

## Decided in the architecture (kept for reference)

- **No integration with government-issued systems** — the district runs this independently;
  departments' upward reports are produced as **exports**, not by connecting to other systems.
- **Severity has an explicit `unknown`** — a value, never a level (ADR-0009).
- **Nothing above the district** in this system — the ladder is department → DC Office / AC
  Headquarter (ADR-0010). Reopen only if Bajaur asks for provincial notification.
- **No place gazetteer** — GPS when available, free text otherwise.

When a question is answered: write the answer, its source (who said it) and the date, and update
every document the answer affects. Never put an unconfirmed Bajaur fact into code.
