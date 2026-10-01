# ADR-0018 — Nobody but the control room signs in, and the in-app inbox is removed

**Status:** Accepted
**Date:** 2026-08-06
**Reversal cost:** Medium — the inbox is deleted rather than hidden, so bringing it back is
writing it again. See *"Why deletion, and not the flag"* below; this was decided knowingly.
**Supersedes:** part of [ADR-0016](ADR-0016-control-room-first.md) — *hidden, not deleted* no
longer holds for the in-app notification channel and inbox. The rest of ADR-0016 stands.
**Amends:** [ADR-0014](ADR-0014-the-software-sends-again.md) — WhatsApp is no longer *a*
channel beside the inbox. It is **the** channel.
**Source:** the project owner, 2026-08-06, after using the product.

---

## Context

ADR-0016 made the control room the product and hid every other screen behind a capability. It
stopped short of one thing, and that thing turned out to be the whole point:

**it still assumed that somebody outside the control room would eventually sign in.**

The district's own words, after using it:

> Ye system sirf control base kaam karega: control room hi feeding karega, aur control hi
> emergencies, alerts etc. assign karega. Kisi bhi personnel ko in-app access nahi milega.
> Sab department es liye hain app mein ke control ke liye asaani ho — emergency ya alerts ki
> selection karte waqt.

Three consequences follow, and the third is the one that forces this decision.

**Departments are a directory, not an audience.** They exist so the control room can pick them.
Nobody in them holds a password; nobody in them ever will. This was already almost true — of
~80 officials in Bajaur's directory, two or three have credentials (M0-51 deliberately loads
people with a null `password_hash`).

**Everything leaves by WhatsApp.** Emergency, alert, advisory, order — one outbound mechanism,
one acknowledge link, one inbound signal.

**The in-app inbox was not merely unused. It was actively harmful.** Every dispatch created an
obligation whose only settlement was the recipient opening the app. Nobody would. So each one
sat `pending`, aged past `UNDELIVERED_AFTER_MINUTES`, and became a permanent unmet obligation
on the board — for ever, growing, unfixable. **INV-03 exists to make real failures visible, and
this manufactured false ones at a rate of one per recipient per emergency.** A district that
learns to ignore the unmet count has lost the number that matters at 02:00, and this was
teaching them to.

## Decision

**Nobody but the control room signs in. The in-app notification channel and the inbox screen
are removed from the codebase.**

- **Removed:** `inAppChannel`, `api/notifications.ts`, `GET /notifications`,
  `POST /notifications/:id/seen`, the inbox screen and its navigation entry.
- **The ledger is not removed.** `notified`, `notification_delivered` and `notification_failed`,
  `obligationsFor`, `unmetObligations` and the board's unmet counts all stay exactly as they
  are. They **are** INV-03, and WhatsApp settles them through the same events. What is deleted
  is one *channel* and one *receiving surface*, not the accounting around them.
- **The outbox is not removed, and this is the sentence that matters most in this ADR.** It is
  not an "in-app" feature in the sense being deleted: it is how the **control room's own**
  reports become durable before they reach the server, and it is what `spine.e2e.test.ts`
  proves INV-01 with. The district office in Bajaur loses power and loses its line. Deleting the
  outbox because the phrase "in-app" appears near it would remove the one claim this project
  exists to make, and it would remove it from an installation that uses it every day.

### What replaces it before WhatsApp exists

With the inbox gone and no Meta account yet, **no automatic channel exists at all.** That is
stated plainly rather than papered over:

- An obligation is still recorded — somebody was owed a message — and immediately marked as
  needing a human, naming that no automatic channel is configured.
- The operator uses **"Reach them"**, which opens WhatsApp or the dialler on their own handset
  and records `contact_opened` (M6-10).
- **The operator records what they were told** (M7). They ring, the officer says *"theek hai,
  ja raha hun"*, and that sentence gets a place in the system for the first time. It is
  recorded as **the operator's own statement**, never as a delivery the machine observed — two
  different facts, two different words.

That last piece is not a stopgap. WhatsApp will fail some nights, and when it does the
telephone is the system; an operator who cannot record what they heard is an operator whose
work leaves no trace, which is the paper register returning.

## Why deletion, and not the flag

ADR-0016 argued for hiding, and its argument was good: migration 0018 dropped the provider
ladder for excellent reasons on 2026-08-03, and ADR-0014 rebuilt a version of it forty-eight
hours later. Scope moves.

**The owner chose deletion, and the concern above was put to them before they did.** Recorded
here because a decision made against a stated objection should be findable, not because it was
wrong.

Two things do make this case different from the ladder, and they are worth stating so the next
session can judge it rather than re-litigate it:

- **The ladder was removed over a policy.** *Should the software send?* — a preference, and
  preferences reverse. This is removed over a **population**: nobody outside the control room
  has an account or will be given one. That is a fact about who the district is, and it moves
  far more slowly than a preference.
- **The ladder was merely unused. The inbox was harmful.** Leaving it switched off would have
  been enough to stop the harm — but a channel nobody may use, in a product with one user, is
  code that will be read, maintained and eventually wired back in by somebody who assumes it is
  there for a reason.

**If departments are ever given access, the inbox is written again.** That is understood and
accepted. The events it read are still in the log, so nothing about the district's history
depends on it.

## Consequences

- **Acknowledgment has exactly three sources**, and until the Meta account exists only the
  third works: the WhatsApp acknowledge link (M6-22), an inbound WhatsApp reply (M6-23), and
  the control room recording what it was told by telephone (M7).
- **Performance measurement is re-based on those three.** Median time to acknowledge still
  means what it meant; what changed is who can produce the acknowledgement.
- **Resolution and closure become the control room's** — they are the only ones signed in. The
  authority table already permits this (district tier overrides on `incident.closure`); no
  policy row changes.
- **`markObligationMet` keeps working unchanged.** It settles on a deliberate act, and all
  three remaining sources are deliberate acts.
- **M6-45's test changes.** It asserts that hidden screens stay in the repository, and the
  inbox is now gone. The rule it protects — *a test suite that shrinks when scope narrows was
  measuring scope, not correctness* — still holds for everything else on its list, and the
  outbox line in it is now the most important one.
- **Escalation still fires and still records.** What it can no longer do is put a message in
  somebody's inbox; it goes out the same way everything else does.

## What this does not change

- The event log is still the record (ADR-0001).
- The offline substrate stays, tested, and in the M0 gate (ADR-0002, INV-01).
- Authority is still enforced server-side on every request (ADR-0003, INV-05). Removing an
  audience does not remove the checks — if access is ever granted again, the boundary is
  already there rather than needing to be rebuilt under time pressure.
- A read receipt still never counts as the obligation being met (ADR-0014).
