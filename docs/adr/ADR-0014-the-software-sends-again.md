# ADR-0014 — The software sends the message, on one number the district owns

**Status:** Accepted
**Date:** 2026-08-05
**Reversal cost:** Medium — one channel implementation, one webhook, one migration. The
ledger it writes into already exists and does not change.
**Supersedes:** the 2026-08-03 supersession of [ADR-0012](ADR-0012-notification-channel-ladder.md)
and migration `0018_no_provider_ladder`.
**Source:** the district, via the project owner, 2026-08-05.

---

## This reverses a reversal, and that is worth saying plainly

On 2026-08-02 ADR-0012 decided the system would send alerts down a ladder of providers. On
2026-08-03 the owner threw it out — nothing of the sort had been asked for — and migration
0018 dropped `channel_ladder`, the adapters, the Meta templates and the Alerts tab. What
survived was the right thing: the software **hands an officer the number**, a click opens
WhatsApp or the dialler on that officer's own handset, and **nothing is recorded**.

The district has now seen that working and asked for something different:

> alert, update ya emergency un ko phone ki through ajate hai, software kholte hain, details
> dete hain, mutalqa department ya personal ya post ajaye, ya multiple selection k lye option
> bhi ajaye … control room wala selection kare and unko whatsapp msg chala jaye, dashboard pr
> ajaye k kis kis ko emergency asign hue hai, application pr pata chal jaye k haan msg gaya
> hai, seen hua hai ya nhe, kis kis nai seen kya hai

And on the account, unprompted:

> Hum just aik whatsapp number es application k lye dedicated hi khred lenge, jis sai hum msgs
> bhej ske and if possible wapis kuch naa kuch response bhi wapis es application pr hi receive
> kar ske.

**ADR-0012 was not wrong about the mechanism. It was wrong about the reason.** It proposed a
four-rung provider ladder to solve a problem nobody had — reaching an officer the system had
no other way to reach. What the district actually has is a control room doing this by hand,
on paper and on somebody's personal WhatsApp, forty times a day, with no record of who was
told. The message was never the point. **The record of it was.**

That is why this is not "0012 again". 0012 built a chain of providers so that delivery would
always succeed. This builds **one** channel so that delivery is always *known*.

## Context

The control room's current loop, in full: a call comes in, an officer writes it in a paper
register, opens WhatsApp on a personal handset, forwards it to whichever departments seem
relevant, and repeats. Nothing about who was told, when, or whether they read it survives
past the notebook.

Three facts make this decidable now where it was not on 3 August:

1. **The district is buying a dedicated number.** The longest lead time in ADR-0012 — R-05,
   procuring a Meta account and a SIM — is being paid for by the people who wanted it, rather
   than requested from a district that had not asked.
2. **They want the reply back in the application.** A handset-based flow structurally cannot
   do this. An officer's *"on scene, 2 units"* typed into an officer's personal WhatsApp is
   invisible to the record for ever.
3. **The delivery ledger already exists and is already what INV-03 is measured against.**
   `notified` → `notification_delivered` / `notification_failed`, appended in that order, with
   pending as a real third state. This decision adds a channel to a ledger that was built for
   exactly this and has been running against the in-app inbox since M0-32.

## Decision

**The system sends WhatsApp messages from one number the district owns, through the WhatsApp
Cloud API, and records four distinct facts about every one of them.**

- **One sender, one number.** Not a ladder. No SMS gateway, no voice provider, no GSM modem.
  If WhatsApp is down, the control room is told the message did not go and rings the number
  itself — which is what it does today anyway, and which it can do because the "Reach them"
  control from ADR-0012's replacement **stays exactly as it is**.
- **The recipients are chosen by a person**, at intake, from a multi-select of departments,
  posts and individual officers. Routing signals still run and still propose; the control room
  may accept them, add to them, or ignore them. **Automatic routing proposes; a human sends.**
- **Four states, never one tick.** `queued` → `sent` → `delivered` → `read`, from Meta's
  status webhooks, plus a fifth that is not Meta's at all — see below.
- **Every message carries an acknowledge link.** One tap records an attributable
  `acknowledged` event against that officer and that incident.
- **Inbound replies land on the incident.** A reply to an alert becomes an event in the log,
  attributed to the officer whose number it came from.

## Rationale

### Why one channel and not a ladder

The ladder in ADR-0012 was insurance against a message not arriving. But a district that
cannot reach an officer on WhatsApp has a *person* problem, not a *channel* problem, and the
correct response is a human dialling a number — which the system already supports and which
this decision does not touch. Every additional rung is a provider that fails silently, on the
night it matters, in a way nobody tested because testing it means messaging real officers.

**One channel that reports honestly beats four that each might be lying.**

### Why "read" is not the record, and the acknowledge link is

WhatsApp's read receipt is the obvious thing to build the dashboard on, and it is a trap.
**An officer who has disabled read receipts will never produce one** — they read the message
at 02:04, drove to the scene, and the district's screen says *not seen* all night. Worse, the
inverse: a `read` webhook means a phone displayed a message. It does not mean a person who can
act on it saw it, and it certainly does not mean they are coming.

So `read` is carried, shown, and **never counted as the obligation being met**. What meets the
obligation is a deliberate act by the person who holds the post: the acknowledge tap, the
in-app acknowledgement, or a reply. This is the same distinction M0-32 already draws for the
in-app inbox — *"the tab was open" is not "somebody knows"* — applied to a second channel.

This matters more than it sounds. The whole reason INV-03 exists is that a notification
failure must never be invisible. A dashboard that counts read receipts as success would
manufacture invisible failures at exactly the rate officers disable a privacy setting.

### Why the district's own number, and not an officer's

An officer's SIM leaves with the officer. The number every department in Bajaur learns to
recognise as *the district's alert number* must outlive whoever currently sits in the control
room, and must not stop working because somebody was transferred to another district.

## Consequences

### We gain
- The control room's loop becomes one screen: type it, select who, send. The paper register
  and the personal handset both leave the critical path.
- **The district can answer "who was told, and did they respond?" for any emergency, ever** —
  from the same event log everything else folds from. That question currently has no answer.
- Officers' replies enter the record instead of evaporating into a personal chat.

### We give up
- **R-05 comes back**, having been closed as not-needed on 3 August. A Meta business account,
  business verification, a registered number and approved templates are prerequisites again.
  This is now the longest lead time in the project for a second time.
- A recurring per-message cost, small at this volume, on an account somebody must keep funded.
  A gateway out of credit is a silent failure — so **the balance is a `condition` row on the
  dashboard**, next to the backup and the standby, for the same reason those are there.
- A dependency with an answer required by §7: *who restarts this when it fails, and how do
  they know it failed?* Answer: nobody restarts it — a send that fails writes
  `notification_failed` and the control room sees an unmet obligation on the board, which is
  the existing mechanism and needs no new watcher.

### We must therefore also
- Keep the "Reach them" control **unchanged and reachable**. It is the fallback, and on the
  night the API is down it is the whole system.
- Record the contact attempt when that control is used. ADR-0012's replacement deliberately
  recorded nothing; the district now wants status, so a click becomes an event —
  `contact_opened`, which states only that an app was opened, because that is all we know.
- Rate-limit the send path against Meta's tiered messaging limits (a new number starts
  restricted), and **queue rather than drop** when the limit is hit.
- Never let a send failure fail an intake. INV-01 outranks every part of this ADR.

## Alternatives considered

**An unofficial WhatsApp Web library (Baileys, whatsapp-web.js).** No account, no verification,
no template approval, read receipts included, and it works this week. Rejected: it violates
WhatsApp's terms, and the failure mode is the district's alert number being banned without
warning or appeal. A system of record for a district's emergencies cannot rest on a channel
that can be switched off by a policy engine with no one to ask. Reconsider only as a
stop-gap the district chooses with this paragraph in front of them.

**Keep handing over the number (the status quo).** Rejected for one reason only: it cannot
answer *who was told*. Everything else about it is better.

**SMS instead.** Delivery receipts exist, read receipts do not, and every officer already has
WhatsApp. It solves less and costs more.

## How we would know this was wrong

- **Officers reply on WhatsApp and nobody in the control room reads the replies in the app.**
  That means the inbound half was built for a workflow that does not exist, and it should be
  cut back to outbound-only.
- **The acknowledge link goes untapped** while incidents are acknowledged in-app or by phone.
  Then the link is ceremony, and the honest ledger is `delivered` plus the existing
  acknowledgement.
- **A month passes with no `notification_failed` at all.** That is not success; it is the
  ledger not being wired to the truth. INV-03's whole premise is that failures exist and must
  be visible.
- **The account is suspended, or the bill goes unpaid for a month.** Then the district cannot
  operate a channel that requires an account, and the 3 August decision was right after all.
