# ADR-0012 — Notifications walk a ladder: WhatsApp, then a phone call

**Status:** **SUPERSEDED · 2026-08-03** — see the note below. Originally accepted 2026-08-02
**Resolves:** Q-07. Builds on `M0-32` (the delivery ledger) and `ADR-0005` (silence is a
signal).
**Source:** project owner, 2026-08-02.

---

## Superseded — 2026-08-03

**This ADR is wrong, and it was wrong from the moment it was written.** It is left in place
because the ADR log is corrected by appending, not by making the past look like it always
agreed (ADR-0001's reasoning, applied to this folder).

What it decided: the system would send alerts down a ladder of providers — WhatsApp Business,
a voice provider, an SMS gateway, and a GSM modem in the DC office — with four message
templates submitted to Meta for approval.

**None of that was ever asked for.** The owner's answer to Q-07 said WhatsApp was the first
priority and that a person should be able to route a notification another way. I read that as
*the software will send WhatsApp messages*. It meant something much simpler. The owner, on
seeing what had been built:

> es ka ye matlab nhe hai k software call karega, jis k lye tum nai itne saare chez deye hue
> hain, es ka ye matlab tha k **ju banda alert jare karega ya escalate karega etc etc un ko
> mutalqa number mil jaye and us pr click kare tou contact karne ka channel selection mai ho**,
> select kare tou wo us channel par jaega jaha sai wo desired contact kar skega … es mai Meta
> business account, telephony ya SMS gateway ki koi zarurt nhe hai

## What replaces it

**The software hands an officer the number.** On the incident, on live work, and on the
console's department cards, a "Reach them" control shows the duty officer's mobile and the
department's office line, and a click opens WhatsApp, the dialler or messages **on that
officer's own handset**. A human has the conversation.

- `GET /contacts/department/:id` — the numbers, behind a session.
- `web/src/contact.ts` — the picker: WhatsApp, Call, SMS, Copy.
- **Nothing is recorded** when a channel is opened, by the owner's decision. The panel says so
  rather than implying otherwise: no tick appears, nothing reads "notified".

## Why this is better, and not merely smaller

A chain of providers fails in ways nobody sees. A template goes unapproved, a gateway runs out
of credit, a modem loses signal — and every one of those is discovered on the night it
matters, by an emergency that reached nobody. There is no way to test it that does not involve
sending real messages to real people.

An officer who dialled a number knows within ten seconds whether it rang.

It also removes the longest lead time in the project. R-05 asked the district for a Meta
business account with approved templates, an SMS gateway, a telephony provider and a GSM SIM.
None of that is needed now, and the district has fewer things to procure before this system
is useful than it did yesterday.

## What survives

**The in-app inbox and the obligation ledger** (M0-32). Every notification a post is owed is
still recorded before anything is attempted, still shown in that post's "Waiting for you", and
still counted on the board as an unmet obligation until a human collects it. That is INV-03,
and it needs no provider — which is the part of the original design that was always right.


## Context — as written on 2026-08-02

Q-07 asked which notification channels are actually reliable in Bajaur. The owner's answer:

> **WhatsApp is first priority.** If WhatsApp is not reachable, it should redirect to a
> **direct call** on the phone network. And the user should be able to choose to route a
> notification to another channel when they need to.

The delivery ledger built in M0-32 already records every attempt with its channel and outcome,
and already treats the channel as pluggable, so the shape was right. What was missing was the
policy: which channel, in what order, and who decides.

## Decision

### A notification is an obligation, not a message

The system owes a seat an alert. **The channel is how it discharges the obligation, and it
keeps trying down a ladder until one succeeds or the ladder runs out.** Every rung is recorded
in the ledger, so "we told them" is always answerable with which channel, at what time, and
whether it landed.

### The default ladder

1. **WhatsApp** — first, per the owner.
2. **Voice call** — when WhatsApp does not reach them.
3. **SMS** — a written record that survives a missed call.
4. **In-app inbox** — always, in parallel. Already built. Costs nothing and needs no provider.

The ladder is **configuration**, edited from the administrative dashboards (ADR-0010), not
code. A seat may set its own preference; a specific notification may override it, which is the
per-notification choice the owner asked for.

### Two different internets, and only one of them is optional

This distinction decides what actually works, and it was not in the question:

- **The recipient's internet.** WhatsApp needs the officer's handset to have data. If they do
  not, the ladder falls to a voice call. **This is exactly what the owner described, and it is
  fully buildable.**
- **The server's internet.** The DC office machine must reach Meta and the telephony provider
  to send anything at all. If the district's line is down, WhatsApp cannot be sent, and neither
  can a call placed through an internet telephony provider.

So there is a rung below all of them:

5. **GSM modem or SIM gateway** — a small device with a SIM card, attached to the DC server.
   It sends SMS and places calls over the **mobile network**, needing no internet on either
   end. It is the only channel that survives an internet outage in the district.

Given ADR-0011 puts the server in the DC office precisely so a district internet failure does
not stop work, a ladder that goes entirely dark in that failure would be incoherent. **The GSM
modem is recommended, not optional dressing** — the hardware is cheap and it is the difference
between escalation reaching a human and escalation reaching a log entry.

### Failure is loud

A notification that exhausts the ladder is **not** marked delivered and **not** left quiet. It
surfaces as undelivered on both administrative dashboards, which is the behaviour already
built and tested (`notificationsUndelivered`, `UNDELIVERED_AFTER_MINUTES`). ADR-0005 applies:
the absence of a delivery is the signal.

## Consequences

**Good**

- One policy, expressed as data, covers "WhatsApp first", "call if they are unreachable", and
  "send this one by SMS instead" without three code paths.
- The ledger already answers the question that matters after an incident: *did the message
  reach them, and how do we know?*

**Costs and real-world prerequisites**

These have lead time and cost money. They are not engineering blockers — the adapters can be
built and tested against fakes — but nothing reaches a real phone until they exist:

- **WhatsApp Business API** — a Meta business account, a verified sending number, and
  **pre-approved message templates**. Alerts are business-initiated, so Meta must approve the
  wording in advance. This is the longest lead time in the list, and the templates must be
  drafted before approval can start.
- **SMS gateway** — an account with a Pakistani provider.
- **Voice** — a telephony provider, or the GSM modem.
- **GSM modem** — hardware, a SIM, and a slot in the DC office server.

**Rejected**

- *Waiting for accounts before building.* The channels go behind an interface with a fake
  implementation, exactly as the in-app channel already is. Provisioning happens in parallel.
- *Best-effort delivery with no ledger.* An unrecorded attempt is indistinguishable from no
  attempt, and this system exists because things get lost quietly.
