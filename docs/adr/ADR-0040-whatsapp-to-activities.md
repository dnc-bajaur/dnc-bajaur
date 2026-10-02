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

## Implementation notes (phase D, 2026-10-02)

Built in `app/src/api/whatsappActivities.ts` (migration `0053`, sweep `jobs/activitiesInbound.ts`,
test `api/__tests__/whatsappActivities.test.ts`). Where the build had to decide something this ADR
did not say:

- **Only photos and videos.** A voice note, document, sticker, words, a pin or any other tap take
  today's path untouched. Activities accepts JPEG/PNG/WebP photos and MP4/MOV videos, as in-app.
- **"Open emergency"** is the incident today's path would attach the media to — the message the
  officer replied to, else the most recent alert to that number within 24 hours — when it is not
  resolved or closed. Any kind (emergency, notice, meeting) counts: asking costs one tap, and not
  asking could lose an emergency's photo.
- **Button titles.** Meta allows 20 characters, so the buttons read *Emergency report* / *Daily
  activity*, and the question above them names the incident: *"You have an open emergency,
  DNC-BAJAUR-n. Is this picture a report for it, or a daily activity?"*
- **The emergency branch is today's path**, called with the bytes already fetched (Meta's link may
  have expired by the tap). Its note says the officer *chose* the incident — an exact match. If the
  question cannot be sent, or the file cannot be fetched or is not a type Activities takes, an
  emergency's media goes down today's path at once rather than waiting on a tap.
- **A known sender** is exactly one account (signs in, not removed) whose number matches. It must
  hold `activities.upload` and not be suspended, and have a live default department; otherwise
  the media goes to the Pending list, saying why. Two accounts on one number → the DC chooses.
- **Replies.** *"Received — added to Activities."* once per post (not per photo of an album).
  Media going to the Pending list gets *"Received — the DC office will add it to Activities."*
  once, so the sender is not left with silence. A second tap on an answered question gets *"This
  has already been dealt with."*
- **A late tap counts.** A question moved to the Pending list for no answer can still be answered
  by the officer until the DC decides it.
- **Who clears the Pending list** is the `activities.pending` permission (DC and DNC by default).
  Approve chooses account, department and date; reject is a hard delete. Both are logged.
- **30 days.** Held media is deleted after 30 days like any post (`pending_expired` in the log).
- **The date** of any post can be changed afterwards by its author or a moderator (`date_changed`).
- **The switch:** `WHATSAPP_ACTIVITIES=off` turns it off; every photo and video is then evidence
  as before. The Pending list and the sweep keep working for anything already held.

## How we would know this was wrong

Officers often choose the wrong button, or the Pending list fills with ordinary emergency
photos. Either is the signal to revisit — most likely in favour of a second number.
