# ADR-0044 — Activities as a feed: reactions, comments, and Respond

**Status:** Accepted · 2026-10-03 · Respond built against a stubbed Meta; go-live needs Bajaur's
Meta account, and an approved template for messages sent after the 24-hour window.
**Decided by:** the owner, in conversation on 2026-10-03, after trying the Activities screens with
a new account: *"it is confusing, mostly for the DC … simple enough to understand at one look."*
**Amends:** [ADR-0039](ADR-0039-activities.md) §5 (the views), [ADR-0041](ADR-0041-directory-contacts-post-activities.md)
§9 (who sees a phone number), [ADR-0038](ADR-0038-member-accounts.md) §3 (two new permissions).
**Rests on:** [ADR-0014](ADR-0014-the-software-sends-again.md) / 0034 (one district number;
delivery must be known), [ADR-0040](ADR-0040-whatsapp-to-activities.md) (what arrives on that
number).
**Reversal cost:** Low — three new tables that cascade with their post, two permissions, one page.
Nothing here touches incidents, evidence or the event log.

## Context

Activities opened on a form — Department, Person, From, To — above the posts, beside six tabs of
equal weight. The DC had to read a form before seeing a single picture. A photo grid (a phone's
gallery) was considered first and dropped by the owner: most posts carry words, and a grid hides
them. And a post was a dead end: the DC could look at it and do nothing else.

## Decision

1. **Activities opens on the feed.** Two buttons above it — **All** and **Departments** — and
   nothing else. *Departments* lists every department with how many posts it holds; choosing one
   shows that department's feed. Person and date are still there, behind **Filter**.
2. **A post is a card that says who sent it:** name, post, department, **mobile number**, when —
   then the words, then the photos, videos and voice notes. The number is shown to **every account
   that can see the post** (owner's decision), not only to the DC.
3. **Fewer tabs.** *Activities* and *New post* stay in front. *Pending* shows only while something
   is waiting. *Officers*, *History* and *My account* sit under **More** when the account has more
   than *My account* there.
4. **Reactions.** Any account that can see a post may put one mark on it — *Seen* or *Well done* —
   and take it off again. One per person per post; the card shows the counts and the names.
5. **Comments.** Any account that can see a post may comment (permission `activities.comment`,
   held by every role — a `viewer` included; the DC can deny it to one account). A comment is
   deleted by its author or by a moderator; a moderator's delete of somebody else's is logged.
   **Reactions and comments never leave the app** — nothing is sent on WhatsApp for them.
6. **Respond.** The DC and the control room (`activities.respond`: `owner`, `admin`, `operator`)
   may write a message to the person who sent a post. It goes **only to that person's number**,
   from the district number, and **says what it is** — it opens *"Activities — message from the DC
   office"*, quotes the post, and ends *"This is not an emergency alert."* It is not an incident:
   no SLA, no escalation, no acknowledgement, nothing in the event log.
   - Inside Meta's 24-hour window (the officer wrote to the number in the last day — which a
     fresh post sent by WhatsApp always means) it is a plain message. It is **not** attached to
     the officer's own picture with WhatsApp's reply: Meta refuses a reply to a message that is
     too old, and a courtesy must not be able to stop the send. The words quote the post instead.
   - Outside it, Meta accepts only an approved template: `dnc_bajaur_activity_response`
     (`WHATSAPP_TEMPLATE_ACTIVITY`). **With no template, nothing is sent and the screen says so**
     — a Respond is never dropped quietly.
   - **Delivery is known** (INV-03): sent, delivered, read or failed with Meta's reason, shown
     under the post.
   - The button, the messages sent and the officer's answers are shown **only to accounts that
     hold `activities.respond`**; the server leaves them out for everybody else (INV-05).
   - Logged: `responded` in the Activities log — who, which post, when (INV-06). The words
     themselves stay on the post and go when it does.
7. **The officer's answer comes back to the same post.**
   - Sent with WhatsApp's own *reply* to our message → that post, exactly.
   - Plain words with no reply → the post of the last Respond sent to that number in the last 24
     hours, **marked as matched by time** — and only when **no alert went to that number in those
     24 hours**. With an alert, the words may be about the emergency and take today's path
     unchanged: an answer to an emergency is never diverted into Activities. Without one, today's
     path would have dropped them.
   - A photo or a voice note sent as a reply is kept **on the answer**, seen only by those who can
     respond. A video sent as a reply, and any picture, video or voice note sent **without**
     replying, is a new post as today.
8. **Everything goes with the post.** Reactions, comments, responses and answers cascade with it —
   a hard delete, or the 30-day rule.

## Consequences

### We gain
- The DC sees the district's day on opening the page, and can answer an officer from where the
  post is, without a second app and without it reading as an alert.
- Officers who have a login see that their work was looked at.

### We give up
- A phone number on every post, visible to every account. Accepted by the owner.
- Comments reach only people who sign in. Most officers post by WhatsApp and never will; for them
  the only thing that arrives is a Respond.
- "Matched by time" is an inference, the same kind `lastMessageTo` already makes for incidents.
  It is marked as one.
- Answers' files are not copied to the media bucket (they live 30 days with their post).

### We must therefore also
- Submit `dnc_bajaur_activity_response` to Meta with the others and set
  `WHATSAPP_TEMPLATE_ACTIVITY` once approved (`PLAN.md` §3 step 6).
- Rewrite the Activities chapter of the guide, English and Urdu.

## Alternatives considered
- **A photo grid.** Hides the words; rejected by the owner.
- **Send every comment to the officer on WhatsApp.** Noise on the channel emergencies use;
  rejected by the owner in favour of one deliberate Respond.
- **Make a Respond an incident ("query") with a deadline.** A second SLA system beside the real
  one, and an Activities message that looks like an alert — exactly what was asked not to happen.

## How we would know this was wrong
- Officers treat a Respond as an alert (they tap for buttons, or call the control room): reword
  the opening line.
- Answers land on the wrong post: look at how many are "matched by time"; if many, ask officers to
  use reply, or stop inferring.
- The DC stops opening Activities: the first screen is still not simple enough.
