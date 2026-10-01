# ADR-0010 — The ladder has two rungs: departments, and the district administration

**Status:** Accepted · 2026-08-02 · **AMENDED 2026-08-20 by
[ADR-0022](./ADR-0022-the-control-room-assigns.md) — the routing clause below is removed. The two
rungs stand; nothing routes itself any more. Read the amendment before acting on "Routing is
configuration, not inference".**
**Resolves:** Q-18. Supersedes the four-tier assumption in `ADR-0004` and
`docs/04-authority-model.md`.
**Source:** project owner, 2026-08-02.

## Context

`ADR-0004` introduced seats with four tiers — `station`, `tehsil`, `district`, `provincial` —
and an escalation ladder that walks up them. That was a **generic** hierarchy, designed
before anybody had told us how Bajaur is actually organised, and `CLAUDE.md` has said all
along that anything domain-specific was assumption rather than fact.

Loading the district's contact list made the gap concrete: 81 posts arrived with no tier
information at all, so every one of them defaulted to `district`, and the ladder had nowhere
to climb. That was recorded as Q-18 and flagged as the highest-value open question.

The answer, from the owner, is simpler than the model:

> This software is designed specifically for the **District Administration**. Only two
> offices are responsible for the whole district — the **DC Office** and the **AC
> Headquarter Bajaur Office**. Every other department reports to those two, and those two
> assign tasks and alerts to the departments.

## Decision

**The ladder has two rungs.**

1. **District administration** — the DC Office and the AC Headquarter Bajaur Office. The
   authority for the entire district. Their dashboards are administrative: they create,
   edit and retire departments, add people and their contact numbers, set the SLA rules,
   configure routing, and assign anything the system could not route itself.
2. **Departments** — everything else. They receive work, acknowledge it, act on it, and
   report upward. They may add their own people for emergency reporting.

**There is no third rung.** An unacknowledged emergency escalates from a department to the
district administration, and that is the top. Provincial escalation is **out of scope**
unless the district says otherwise (this closes Q-10).

> ⚠️ **REMOVED 2026-08-20 by [ADR-0022](./ADR-0022-the-control-room-assigns.md).** The district
> never wrote a single signal — R-04 was open for eighteen days and `routing_signal` held zero
> live rows for the whole life of the installation — and the control room, who were assigning by
> hand the entire time, said the mechanism confused them. The paragraph is kept as written,
> because an ADR is not edited. It is no longer true of the system.

**Routing is configuration, not inference.** Each department carries **routing signals** —
the categories of emergency it answers for. A bazaar fire routes to Rescue; heatstroke cases
route to Health. The signals are data the district administration edits, exactly like the
authority rules (ADR-0003).

**Anything the system cannot route is escalated to a human immediately, and loudly.** An
emergency with no matching signal is not guessed at and not held quietly: it appears on both
administrative dashboards marked **unassigned**, with a note saying so, and the DC or AC
office assigns it. Silence is not an option here (ADR-0005).

> ⚠️ **Amended 2026-08-20 by [ADR-0022](./ADR-0022-the-control-room-assigns.md), and the last
> sentence is the part that survives.** There is no matching to fail now: **every** emergency
> arrives unassigned and the DC or AC office assigns it — what this paragraph described as the
> exception is the whole path. `unassigned` therefore stopped being a fault and became a
> worklist. Silence is still not an option.

## Clarifications, 2026-08-02

Two follow-up questions were put to the owner once the two rungs were agreed, because both
decide code rather than wording.

**The AACs and the TMOs are departments, not administration.** AAC Mamund, AAC Nawagai, AAC
Salarzai, AAC Barang and the TMOs are field offices of the administration in the civil-service
sense, so it was not obvious which rung they sit on. The owner: *"they have to report the
issue or act on the issue."* Reporting up and acting on assigned work is the definition of the
lower rung. They are departments. **Only two offices in the district hold administrative
authority**, and the number of district offices does not dilute that.

Implemented as `department.is_administration` — on the office, not on a seat, because an
office survives a transfer (ADR-0004) and the DC Office holds several posts that are all part
of the administration. The flag is **not settable through the admin API**: these two offices
can create and retire departments, so a flag they could grant would let them mint a third
administration, which is the thing this ADR forbids.

**The DC and AC Headquarter dashboards are identical.** The owner: *"yes exactly, they should
hold the same dashboards."* Neither office outranks the other in this system. There is one
administrative role, held by two seats, with the same powers and the same view.

This is worth stating in an ADR rather than leaving as a build detail, because it forbids a
tempting refactor: **do not introduce a "super-admin" or a DC-only capability later** without
revisiting this. If the two offices ever need different powers, that is a change to the
authority model, not a convenience flag.

## Consequences

**Good**

- The ladder becomes something one person can hold in their head, which is the test
  `ADR-0007` applies to everything else.
- `evaluateRead` already gives district-tier seats sight of everything, so the two offices
  see the whole district with no special case.
- "Escalation exhausted" — already handled as *needs a human, urgently* — is now the honest
  top of the ladder rather than a placeholder for a tier nobody had defined.
- Departments are **editable data**, not code. That is what M2's gate asks for, and it
  arrives a milestone early as a consequence of this decision rather than as work.

**Costs, accepted**

- `Tier` keeps four values in the type for now; only two are used, and the escalation ladder
  is expressed in terms of the two. Collapsing the enum is a follow-up, not a prerequisite —
  and leaving the unused values costs nothing except a comment explaining why they are there.
- A department with no routing signal produces an unassigned alert every time. That is
  intended: it is a prompt to configure the signal, and it is visible rather than silent.

**Rejected**

- *Inferring the responsible department from the report text.* `CLAUDE.md` is explicit that
  no AI sits in the critical path and that nothing but a human or a configured rule may
  route. Keyword signals set by the district are configuration; a model guessing at Urdu
  free text is not, and it would be wrong at exactly the wrong moment.
- *Keeping the four-tier ladder "in case".* A hierarchy nobody uses is a hierarchy nobody
  maintains, and it was already producing a roster where escalation could not work.
