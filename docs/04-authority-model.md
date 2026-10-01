# Authority Model

The requirement most likely to be implemented badly, because it sounds simple in a
sentence and is genuinely subtle in practice:

> Departments own their data. Central administration can view everything and edit some of
> it. There is one record, not two copies being synchronised.

Making authority **data** — and making overrides **additive rather than destructive** — is
what keeps this honest.

---

## Ownership is not authority

Two distinct concepts, routinely conflated:

- **Ownership** — whose data this is, who is accountable for it, whose workspace it
  appears in as editable by default.
- **Authority** — who is permitted to change it, and under what conditions.

The department owns incident severity. The control room has authority to override it. Both
statements are true simultaneously, and the system must be able to say which applied to
any given value at any given moment.

---

## The policy table

Every writable field carries a rule. This is a **database table**, editable by an
administrator and covered by tests — not a set of `if` statements scattered through
controllers.

```
field_key              e.g. "incident.severity"
owner_role             who owns it
override_authority[]   which seats/tiers may override
reason_required        boolean
visible_to_owner       none | yes | yes_and_notify
```

### Current rules

| Field | Owner | Override authority | Reason | Visible to owner |
|---|---|---|---|---|
| Incident severity | Responsible dept | District control room | required | yes, live |
| Incident acknowledgement | Responsible dept | District control room | required | yes, notified |
| Responsible department | System routing | Control room + dept supervisor | required | yes, notified |
| Response actions log | Responsible dept | *none — append only* | — | — |
| Resolution & closure | Responsible dept | DC seat only | required | yes, notified |
| Reporter contact details | Intake | *none* | — | restricted read |
| Department resource status | Owning dept | *none* | — | — |
| Incident category | Responsible dept | Control room | required | yes, live |
| SLA target for a category | District admin | *config, not per-incident* | — | yes |

Adding a field to this table is a normal administrative act. Adding a *new kind of
authority* is an ADR.

**Acknowledgement was added as a row in M0-28**, when the lifecycle became reachable over
HTTP. It belongs here rather than in a bespoke check because it is not a simple ownership
question: the escalation ladder deliberately moves an unacknowledged incident to a district
seat when a department stays silent (`ADR-0004`, `ADR-0005`), and that seat then has to be
able to take it. A district acknowledgement therefore requires a reason — acknowledgement
stops the SLA clock, and the control room stopping another department's clock is precisely
the act that has to be explainable afterwards.

---

## Who may read an incident at all

Write authority is only half of it. Cross-department access is **denied by default**, and
that is enforced server-side on every read (INV-05) — not by which links a workspace
renders.

| Seat | May read |
|---|---|
| In a responsible department | Yes |
| Tehsil tier and above | Yes, everything |
| Any other seat | No — answered as *not found*, never as *forbidden* |
| Any seat, incident not yet routed | Yes |

Three of those need their reasoning stated, because each looks like a mistake:

- **Tehsil and above read everything.** Those tiers hold the routing and override authority
  in the table above, and authority to change a value you may not look at is not authority,
  it is guesswork.
- **A refused read is a 404, not a 403.** Confirming that an incident exists to a seat with
  no authority over it is itself a disclosure about another department's operations.
- **An unrouted incident is readable by anyone.** Until routing has happened nobody owns it,
  and an emergency nobody is permitted to see is an emergency nobody picks up (INV-01). The
  window is small and closes at the first `routed` event.

---

## Three rules that make this hold under pressure

### 1. An override is an event, not an edit

The department's original value survives and stays visible. Nobody can be blamed for a
number they did not enter, and nobody can quietly rewrite a department's assessment.

```
Rescue sets severity = HIGH          → event: triaged
Control room overrides to CRITICAL   → event: overridden (field, old, new, actor, seat, reason)

Projection resolves to CRITICAL.
UI shows: CRITICAL — overridden by District Control Room, 14:22,
          "multiple casualties confirmed by second reporter"
          (Rescue 1122 assessed: HIGH)
```

### 2. Concurrency resolves by authority, then time

If the department and the control room write the same field within the same window, the
**higher authority wins the projection** and the loser is surfaced as a conflict rather
than silently discarded.

The department sees: *"Your update to severity was superseded by a control room override
at 14:22."* Nothing is lost; the disagreement is made visible rather than resolved by
whoever happened to hit save last.

### 3. Provenance is always renderable

Every value on the central board can answer *"who set this, when, and was it
overridden?"* in one click — because that information **is** the record, not a report
generated from it.

---

## Seats, not people

Authority attaches to a **seat** (`ADR-0004`), never to an individual. "The DC seat may
override closure" survives a transfer; "Imran may override closure" does not, and quietly
leaves a departed officer with authority.

An event records both the person and the seat they held at the time, so history remains
truthful after a transfer.

### Handover

Transferring a seat is a first-class, auditable action:

1. Outgoing holder initiates handover.
2. The system lists open incidents, unacknowledged notifications, and pending obligations
   attached to the seat.
3. Incoming holder **explicitly accepts**.
4. `handover` is logged with both parties, the seat, and the accepted obligations.

Authority transfers at acceptance, not at the posting order date.

---

## Emergency access

Real emergencies produce situations the policy table did not anticipate. Rather than
pretend otherwise, there is one deliberate escape hatch:

**Break-glass.** A DC-tier seat may take an action outside its normal authority. Doing so:

- requires a reason, always, with no exception
- is logged as `break_glass` with maximum prominence in the audit trail
- notifies the owning department immediately
- appears on a standing report reviewed after every incident where it was used

It is not a hidden feature and it is not silent. The design assumption is that break-glass
will be used occasionally and legitimately — and that making it visible is safer than
making it impossible, because an impossible escape hatch gets replaced by shared
passwords.

---

## Testing

Authority is data, so it is tested as data:

- Every row in the policy table generates a test: the owner can write, the override
  authority can override with a reason, everyone else is refused.
- Every refusal is tested **by direct API call**, not through the UI (INV-05).
- Cross-department access is tested as denied by default for every resource type.
- Override provenance is asserted in the projection output, not just the event log.
- Break-glass is tested for: reason enforcement, logging, and owner notification.
