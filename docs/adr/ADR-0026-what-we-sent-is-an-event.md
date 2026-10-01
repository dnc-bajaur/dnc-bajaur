# ADR-0026 — What we sent is an event, not a column

**Status:** Accepted · 2026-08-23
**Decided by:** the project owner, choosing between three options put to them. Asked whether the
text of an outbound message should be rebuilt on demand, recorded from today onward, or both, they
chose **record it from today onward**.
**Extends:** [ADR-0001](./ADR-0001-event-log-as-record.md) — the log is the record, and this is a
new thing that happened.
**Constrains:** `db/whatsappStore.ts`, whose header promises the two lookup tables hold no history.

---

## Context

The board row now names who was told and shows what an officer answered. The obvious third
question — *what did we actually tell them?* — turned out to have no answer anywhere in the
system.

The text is composed at send time, in `jobs/whatsappChannel.ts`, from the incident's folded state.
Nothing keeps it:

* **`notified`** is appended **before** the send. That order is the whole of INV-03 — a process
  dying mid-send must leave a visibly pending obligation rather than nothing — and at that moment
  the message does not exist yet.
* **`whatsapp_message`** stores the provider's id, the phone, the status and the timestamps. No
  body. Its own header says why that must stay true: *"drop both tables and the district loses the
  ability to interpret future webhooks and future taps; it loses no record of anything that
  happened."*

So there were three ways forward, and they are not equivalent.

**Rebuild it on demand.** Cheap, works on every historical incident, and wrong in the one case that
matters. The composer runs off *current* state, so a message rebuilt today for an incident that has
since been corrected, rescheduled or reassessed is a sentence that was never sent. The product
already takes this distinction seriously enough to put it in a confirmation dialog: *"This does NOT
unsend anything. Everybody already told still has the original message on their handset."* A board
that then showed a recomposed message under the words *what we sent* would contradict that dialog
on the same screen.

**Record it from today onward.** Nothing historical is recoverable, and every message before this
date shows nothing at all. Honest, and permanently incomplete.

**Both** — rebuild the old ones under a label saying they are rebuilt. Complete, at the cost of two
kinds of truth on one screen and a label somebody will eventually stop reading.

## Decision

**Record it, from today onward, as an event on the log.**

A new event type, `message_sent`, carrying `attemptId`, `what`, `where` and Meta's message id. It
is appended by `jobs/notify.ts` after the channel reports the message was handed off, and it binds
to the attempt the ledger is already tracking.

**It is not a field on `notified`.** That event is written before the send and an append-only log
does not go back and fill a field in. The thing that happened second gets an event of its own.

**It is not a column on `whatsapp_message`.** Putting history in a table documented as not-history
would silently break a property another file is written against.

**It carries `what` and `where` and nothing else.** The outbound message has five fields; the
acknowledge token, the media id and the template name are the envelope. These two are the letter.

**It settles nothing.** Meta accepting a message is not delivery (ADR-0014). The attempt stays
pending until a status webhook or, better, the officer's own tap. A fold that settled an attempt
because the text was recorded would tell the control room an officer knows about an emergency on
the strength of an HTTP 200 from a datacentre.

## Consequences

**Absence means unknown, and every screen must say so in those words.** A row with no
`message_sent` is not a row where nothing was sent — the `notified` event beside it says something
was. `BoardRow.sentMessage` is `null` there and the row draws no line rather than an empty one.
This is the one rule that makes the decision safe, and a screen that renders absence as silence
breaks it.

**The record is permanently incomplete before 2026-08-23**, by choice, and that is written into
`domain/events.ts` where somebody will find it.

**A rebuilt message is still available if the district ever wants it**, and this ADR is what would
have to be reopened first. The composer is unchanged and still pure; what is refused is presenting
its output as *what we sent*.

**The fold never creates an attempt from this event.** A `message_sent` for an attempt the fold has
not seen is dropped — deliberately unlike `notification_delivered`, which is kept, because a
delivery for an unknown attempt is still evidence something reached somebody while a message text
for an unknown attempt is evidence of nothing. Inventing an attempt from it would put an obligation
on the board with no addressee and no reason, which INV-03 would count as unmet for ever.
