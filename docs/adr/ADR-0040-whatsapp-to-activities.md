# ADR-0040 — Pictures sent to the district's WhatsApp number become Activities

**Status:** Accepted · 2026-10-01
**Decided by:** the owner, for the Deputy Commissioner Bajaur.
**Rests on:** [ADR-0039](ADR-0039-activities.md) (Activities), [ADR-0014](ADR-0014-the-software-sends-again.md)
(one number the district owns).
**Constraint:** uses only Bajaur's own, new Meta business portfolio — never any other district's.
**Reversal cost:** Low — switch the route off; in-app upload is unaffected.

## Context

Officers already send their activity pictures over WhatsApp. Letting them keep doing so, to the
district's own number, means no new habit to learn. The same number also carries emergency
alerts, and today an officer's photo in reply is attached to their emergency as evidence — the
two must not be confused.

## Decision

1. **Same number.** Officers send a photo or video (with a caption) to the district's number.
2. **If the sender has an open emergency**, the app asks with two buttons:
   *"Report for DNC-BAJAUR-n"* / *"Daily activity"*.
   - **Emergency** → exactly today's path: attached as evidence, obligation settled. Nothing in
     that path changes except that it runs after the tap.
   - **Activity** → an Activities post; the emergency is not touched.
   - **No answer within 1 hour** → the media goes to the DC's Pending list.

   **If the sender has no open emergency**, the media goes straight to Activities.
3. **A known sender** (the phone matches an account) is posted under that account and its
   default department. **An unknown number** goes to the Pending list, where the DC approves
   (choosing account and department) or rejects (hard delete).
4. **Albums:** media from one sender within 5 minutes becomes one post.
5. **Date:** the day received, editable in the app. Media is downloaded from Meta immediately,
   because its links expire. WhatsApp has already compressed it.
6. **Confirmation:** a reply is sent — *"Received — added to Activities."*

## Rationale

Asking only when there is real ambiguity (an open emergency) keeps the emergency path exactly as
it is and costs the officer one tap, only in that case.

## Consequences

### We gain
- Activity pictures arrive the way officers already send them.

### We give up
- One extra tap for an officer who has an open emergency when they send a picture.

### We must therefore also
- Have Bajaur's new Meta portfolio and number live first.
- Test that the emergency branch produces exactly today's evidence and settlement.

## Alternatives considered

- **A second WhatsApp number for activities** — cleanest, but needs another SIM. Not chosen.
- **A caption keyword (`#activity`)** — easily forgotten, error-prone. Rejected.

## How we would know this was wrong

Officers often choose the wrong button, or the Pending list fills with ordinary emergency
photos. Either is the signal to revisit — most likely in favour of a second number.
