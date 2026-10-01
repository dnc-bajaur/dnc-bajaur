# Engineering Thesis

*Why this system is shaped the way it is. Read this before anything else.*

---

## The root, and what it commits us to

Five statements define this system. Everything else is derived from them, and anything
that cannot be traced back to them is scope.

1. One district-wide operational platform, not a dashboard.
2. A central view of the whole district, live.
3. Department workspaces where each department owns its own data.
4. One source of truth — central may view and override with authority, never copy.
5. Emergency management is the point: captured anywhere, routed correctly, visible
   centrally, acknowledged under SLA, escalated when silent, closed with a complete
   audit trail.

Read carefully, these commit us to three things most "dashboard" projects never confront.

**The platform is the system of record.** If the district's real record lives in a
register on someone's desk and the software is a summary of it, the software is
decorative and will be abandoned within a year.

**Ownership and authority are different things.** The department owns the data, the DC has
authority over some of it, and the system must be able to say which applied to any given
value at any given moment.

**The SLA clock is a promise made to a person in danger.** It cannot be a client-side
timer, cannot be paused by a network outage, and cannot quietly fail to fire.

> The measure of this system is not how much it displays. It is whether one emergency,
> reported from a village with no signal, survives to closure.
>
> *Yeh system ki asal test yeh nahi ke dashboard kitna khoobsurat hai — test yeh hai ke
> signal ke baghair report hui aik emergency bhi zaya na ho.*

---

## Seven decisions that determine whether this works

Each is cheap to make now and extremely expensive to reverse after the first department is
onboarded. Full reasoning in [`adr/`](adr/).

### 1. The event log is the truth. State is a projection of it.

Do not build incident tables with an audit log bolted on the side. Model every meaningful
act — reported, triaged, routed, acknowledged, reassigned, escalated, overridden,
resolved, closed — as an immutable append-only event. The incident's current state is
computed by folding its events. The read model is a cache you are allowed to throw away
and rebuild.

An audit log written *alongside* the data will eventually disagree with the data. An audit
log that *is* the data cannot.

This one decision buys audit, offline replay, central override semantics, conflict
resolution, post-incident reconstruction, and *"what did the DC see at 14:20?"* — all from
one mechanism. It costs us read complexity, which is an acceptable trade in a system
handling hundreds of incidents a day rather than millions.

→ [`ADR-0001`](adr/ADR-0001-event-log-as-record.md)

### 2. Offline is the substrate, not a resilience phase.

Bajaur will have outages — routine poor coverage, and deliberate shutdowns during security
operations. A system that treats connectivity as normal and offline as an edge case will
be built wrong from the first commit.

Every client write is an event with a client-generated UUID, written to a durable local
outbox first, then synced. Idempotency is a property of the write path, not a retrofit.

The consequence is that timestamps get complicated on purpose: every event carries
`occurred_at` (when it happened, per the reporter) and `recorded_at` (when the server
first saw it). SLA measurement uses the first; escalation firing uses the second. See
[`02-connectivity-ladder.md`](02-connectivity-ladder.md).

→ [`ADR-0002`](adr/ADR-0002-offline-first.md)

### 3. Ownership and override are declarative data, never `if` statements.

"The department owns it but central can also edit it" is where projects like this rot.
Implemented as role checks scattered through controllers, it becomes untestable within a
month. Implemented as a policy table — every writable field carrying an owner, an override
authority, whether a reason is mandatory, and whether the override is visible to the
owning department — it stays auditable, and a new department is a row rather than a
release.

A central override never mutates the department's value in place. It appends an override
event that wins in the projection, and the UI always shows both: the department's value,
and who overrode it, when, and why.

→ [`ADR-0003`](adr/ADR-0003-declarative-authority.md) · [`04-authority-model.md`](04-authority-model.md)

### 4. Route to a duty seat, not to a department.

"Notify the Health Department" is not actionable at 03:00. "Notify whoever holds the
Health District Duty Officer seat right now" is.

Model organisational **seats** as first-class entities, with people assigned to them over
time and a duty roster saying who holds each seat currently. Officers in this environment
transfer frequently; a permission model attached to a person breaks on every posting
order, while one attached to a seat survives it — and handover becomes a logged action
instead of an IT ticket.

Escalation is then a walk up the seat hierarchy — not a hardcoded list of phone numbers.

*(Written before the district told us how Bajaur is organised. The hierarchy turned out to
have **two rungs**, not four: a department, then the administration, and nothing above it.
See ADR-0010. The point of the paragraph is unchanged and the shape of the ladder is
simpler than it was drawn here.)*

→ [`ADR-0004`](adr/ADR-0004-duty-seats.md)

### 5. Silence is a signal. Absence of reports is never "all normal."

The most dangerous failure mode of a district dashboard is a calm green screen during an
actual crisis, because the reporting department is offline, overwhelmed, or has stopped
using the system.

Every department carries a heartbeat, and every derived summary carries freshness and
coverage. A department that has not checked in within its expected interval renders as
**no contact** — never as **normal**. No aggregate may be rendered without its coverage:
"3 incidents district-wide" is a lie if two of six tehsils have not reported in nine hours.

→ [`ADR-0005`](adr/ADR-0005-silence-is-a-signal.md)

### 6. One emergency, many reports. Deduplication is a domain concept.

A road accident on the Khar–Nawagai road will be reported by five people in four minutes
through three channels. Treating these as five incidents floods the board, triggers five
notification storms, and destroys response-time metrics.

Model **Report** and **Incident** as separate entities. Reports are cheap and never
rejected; an operator — assisted by a proximity/time/category suggestion — links them to
one incident. Never make a reporter's submission fail because a system thinks it is a
duplicate. Accept everything, reconcile after. Merges are events, so a wrong merge can be
split back out with history intact.

→ [`ADR-0006`](adr/ADR-0006-report-vs-incident.md)

### 7. Boring, single-node, and operable by one person.

The operational reality is a district IT setup, not an SRE rotation. Any architecture
needing a service mesh, a broker cluster, or four repositories to debug a missed
notification is the wrong architecture regardless of its technical merit.

One Postgres, one backend deployable, one frontend, one background worker. The system's
real availability ceiling is set by whoever can fix it at 02:00 — not by its design
diagram.

→ [`ADR-0007`](adr/ADR-0007-boring-stack.md) · [`05-stack.md`](05-stack.md)

---

## Ground truths that change the design

Constraints specific to this district and this user base. Each of these has killed a
government platform somewhere; each is cheap to design for and expensive to discover
during a pilot.

### There are no reliable street addresses

Location capture cannot depend on typed addresses or GPS alone — the reporter may be
indoors, on an old handset, or on SMS. Capture is layered, and any one layer suffices: a
map pin when available, a cascading tehsil → union council → village selector, a
searchable landmark gazetteer, and free text as a last resort.

Building the **Place gazetteer** — every UC, village, major landmark, hospital, police
station and rescue post in Bajaur with coordinates — is a real project deliverable with a
real owner, not a seed script written the night before the pilot.

### Officers transfer; the district does not

Permissions attached to individuals break on every posting order and quietly leave
departed officers with access. Seats and duty assignments fix this, and make **handover a
first-class action**: the outgoing officer hands the seat over, open incidents are listed
and explicitly accepted by the incoming officer, and the handover itself is auditable.

### The system must be faster than the phone call it replaces

This is the adoption constraint, and it outranks every feature. If a Rescue operator can
make a call in eight seconds and the system takes forty, the system loses and the central
board goes quietly false.

The rapid-intake path is budgeted like a performance requirement: **under fifteen seconds
from open to submitted** on a mid-range Android handset over a weak connection, with three
mandatory fields and everything else deferred to enrichment after the fact.

### Language is a technical constraint, not a preference

Operators and field staff will be more fluent in Urdu and Pashto than English. Urdu is
right-to-left, which means bidirectional layout must be designed at the token and
component level from the start rather than patched on. English remains the language of the
audit trail and exports; the operational UI is bilingual. Category names, severity labels
and SMS templates are translated content, not hardcoded strings.

### Something already exists — find out before building

Rescue 1122 runs its own dispatch operation. PDMA has provincial reporting obligations.
Health has DHIS reporting. Building a parallel system that departments must double-enter
into is the fastest route to abandonment.

Research must answer, for each department: *what do you already use, what do you already
have to report upward, and can we consume or feed that instead of competing with it?*
Integration beats replacement. Where integration is impossible, the honest answer is a
manual entry path — not a pretence of automation.

### The escalation ceiling is not the district

A major flood, a mass-casualty incident, or a multi-tehsil emergency exceeds district
authority. The escalation chain needs a defined provincial rung — PDMA and the KP
government — even if v1 implements it as "notify these seats and mark the incident as
provincially escalated" rather than a live integration.

*(Closed as out of scope, 2026-08-02 — Q-10, ADR-0010. The owner's answer is that this
system is for the **district administration**, and there is nothing above the DC and AC
Headquarter offices in it. An emergency that reaches the top unacknowledged is surfaced as*
needs a human, urgently, *which is built. Reopen only if the district asks for provincial
notification — the risk itself has not gone away, only our claim to be solving it.)*

### The control room is a single point of failure

If the central command view exists in one room and that room loses power, connectivity, or
access, the district's coordination layer is gone. A designated secondary location with
the same access, and a periodically tested failover procedure, belongs in the operations
plan from the start.

---

## Why the build order is what it is

Prove the hardest and most uncertain thing first, with real code, while it is still cheap
to be wrong. Documents that have never been tested against a running system are
hypotheses — and the riskiest hypothesis here is the offline emergency path. So that is
what gets built in week one.

Depth before breadth. One department taken all the way down (Rescue 1122) teaches us the
real shape of a department workspace; four departments built shallowly in parallel produce
four mini-apps and a wrong abstraction that then has to be unwound. When departments two
through four are added, the test is not that they work — it is *how* they were added. If
department three required new code paths rather than registry configuration, the
abstraction failed and gets fixed then, rather than repeated four more times.

Full plan in [`../backlog/milestones.md`](../backlog/milestones.md).

---

## The one thing

Build the offline emergency spine first — one report, from a phone with no signal, all the
way to a closed incident with a complete audit trail.

Every other decision in this document is something you can change your mind about later.
That one is not, and everything else is built on top of it.
