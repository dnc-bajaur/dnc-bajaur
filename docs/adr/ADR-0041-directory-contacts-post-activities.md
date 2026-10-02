# ADR-0041 — Directory contacts post Activities by WhatsApp; nothing sent to the number is lost

**Status:** Accepted · 2026-10-02
**Decided by:** the owner, for the Deputy Commissioner Bajaur (conversation of 2026-10-02).
**Amends:** [ADR-0040](ADR-0040-whatsapp-to-activities.md) §2–§3, [ADR-0038](ADR-0038-member-accounts.md) §3
(what a `member` may see).
**Rests on:** [ADR-0039](ADR-0039-activities.md), [ADR-0029](ADR-0029-the-department-layer-is-removed.md)
(a contact is a post and its one holder).
**Reversal cost:** Low — the sender rule and the no-answer rule are each one function.

## Context

ADR-0040 posted a picture automatically only when its number belonged to an **account** — a
sign-in with a password. Most officers will only ever use WhatsApp, so the DC had to give every
one of them a login they would never use, or approve each picture by hand. The owner also found
three gaps: a voice note was not an activity; a message from an unknown number that was not a
picture vanished without a trace; and a picture the officer never classified went to the
Activities Pending list even though it might be an emergency report.

## Decision

1. **Every Directory contact is a known sender.** A number that matches exactly one person who is
   not removed — a Directory contact (holds a live post) or an account — posts under that person.
   No login is needed. An account is still checked: suspended, or `activities.upload` denied →
   Pending. A contact with no login may be stopped the same way, by a `deny` override.
2. **A "General" department** is made the first time it is needed. A known sender with no default
   department posts there instead of waiting on the Pending list.
3. **No answer within the hour → the emergency.** A picture held while the officer was asked
   *emergency report or daily activity?* goes down today's evidence path when the hour runs out.
   Only the officer's own *Daily activity* tap puts it in Activities. **No emergency, notice or
   meeting report ever lands in Activities**, whatever its status.
4. **Voice notes are activities** like photos and videos: sent by a known sender with no open
   emergency they join the post; with an open emergency they are asked about like a picture.
5. **Nothing from an unknown number is lost.** A number that matches nobody and has had no alert
   from us in the last 24 hours: its pictures, videos and voice notes go to the Pending list as
   before; its **words, files and locations** go there too, as messages. A message can only be
   added to the Directory or deleted — it never becomes a post by itself; words sent with media
   become that post's caption.
6. **"Add to Directory" from the Pending list.** The DC types the name and post (and may choose a
   department); the number becomes a Directory contact and its media is posted under it. ⚠️ A
   Directory contact can be sent emergency alerts — this is for officers, not for the public.
7. **Every account sees every post** (`activities.read_all` for `member` too) and manages its own.
   The DC can take the right to see others' posts away from one account with a `deny` override.
8. **"Give login"** on a Directory contact takes a department as well.
9. **The Officers tab** (E2, added 2026-10-02). The DC keeps everyone who posts in one list on
   the Activities page: every Directory contact and every account, each with its **department**,
   an **Activities on/off** switch, and **Give login**. The Departments tab keeps only the list
   of departments (the folders).
   - The list shows phone numbers, so it needs `activities.departments` — the DC's and DNC's.
   - A department can now be set for a contact with no login (before, only for an account).
   - *Activities off* is a `deny` of `activities.upload`, the same override and the same
     permission (`accounts.set_permission`) as the Settings panel, written to the access log. It
     stops both doors: the New post form, and WhatsApp (their media waits on Pending as
     `not_allowed`). The switch and the WhatsApp sender rule share one function
     (`mayPostActivities`), so they cannot disagree.
   - *Give login* here is **always `member`** — Activities only, whatever is asked for. A
     control-room role is given from the contact drawer in the console, never from Activities.

## Consequences

- The DC no longer needs to create logins for officers who only use WhatsApp.
- A wrong number in the Directory now posts under the wrong name. The Directory was already the
  district's source of truth for numbers (it is who gets emergency alerts), so it is held to that.
- The Pending list gains messages that are not pictures. An unknown number writing about an
  emergency would sit there, not on the control room's board — the owner chose this knowingly
  (2026-10-02); a count on the dashboard was offered as a later safeguard.
- Voice notes are kept as they arrive (Ogg/Opus from WhatsApp). Older iPhone browsers may not
  play Ogg; converting them is left for later.

## How we would know this was wrong

Pictures posted under the wrong officer (a stale number in the Directory), or the Pending list
filling with chatter nobody reads. Either is the signal to revisit.
