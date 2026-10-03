# ADR-0043 — A sign-in link on WhatsApp: the officer sets their own password

**Status:** Accepted · 2026-10-03 · built against a stubbed Meta; go-live needs Bajaur's Meta
account and an approved template.
**Decided by:** the owner (PLAN §4 E5, agreed 2026-10-01: *"when a login is given, a sign-in link
on WhatsApp — the officer sets their own password"*). The details below were chosen while the
owner was away, under their instruction to keep going.
**Amends:** [ADR-0038](ADR-0038-member-accounts.md) §5 (how a login is given).
**Rests on:** [ADR-0014](ADR-0014-the-software-sends-again.md) (one district number; delivery must be
known), the acknowledge link's token rules (`db/whatsappStore.ts`: only a hash is stored; a GET
never spends a token).
**Reversal cost:** Low — one table, one page, two routes; giving a login with a typed password
keeps working throughout.

## Context

"Give login" asks the DC to type a temporary password and then tell it to the officer — by phone,
or by a WhatsApp message from somebody's own handset. The DC has then seen the password, it sits in
a chat history, and the officer must change it at first sign-in anyway.

## Decision

1. **A login can be given with no password.** The account is made with a random password nobody
   knows, and a **sign-in link** is issued instead. The typed-password way stays available.
2. **A link is single-use, lasts 72 hours, and only its SHA-256 is stored.** Issuing a new link for
   the same person cancels any unused one. A link stops working if the account is suspended,
   removed or disabled.
3. **Opening the link spends nothing** (WhatsApp fetches links to draw a preview). The page shows
   whose account it is and asks for a new password; **submitting** it sets the password, signs out
   every other session of that account, and signs the officer in — a member lands on Activities.
4. **Sending:** when the district's WhatsApp account has an approved login template
   (`WHATSAPP_TEMPLATE_LOGIN`), the link goes to the officer's number from the district number,
   as a URL button (`{PUBLIC_ORIGIN}/set-password/` + token). **Whether it was sent is shown to
   the DC at once** — sent, not sent (no template yet) or failed with Meta's reason (INV-03). With
   no template, the DC is given the link to send by hand; this is the path until go-live.
5. **The same link resets a forgotten password.** "Send sign-in link" is offered for any account
   (`accounts.reset_password`), and on the Officers tab for members.
6. **Audited:** `login_link_issued` (by whom, how it was sent) and `login_link_used` in the access
   log (migration 0055).

## Consequences

### We gain
- The DC never sees an officer's password; nothing secret sits in a chat history for long — an
  unused link dies in 72 hours, a used one at once.
- A forgotten password no longer needs the DC to invent and dictate a new one.

### We give up
- Anyone holding the officer's handset while the link is live can set the password. That is the
  same trust the acknowledge link already places in the handset.
- Delivery receipts are not tracked for this message (only "Meta accepted it"); the officer using
  the link is the confirmation, and the Officers tab says whether the link is still unused.

### We must therefore also
- Submit the login template to Meta with the others (`npm run submit:template --name
  dnc_bajaur_login_link`), and set `WHATSAPP_TEMPLATE_LOGIN` once it is approved.

## Alternatives considered
- **A one-time code by SMS or WhatsApp authentication template.** Needs a second provider (SMS) or
  Meta's OTP format, and the officer still has to type a password afterwards. Rejected.
- **The DC keeps typing passwords.** What exists; kept as a fallback, not the default.

## How we would know this was wrong
- Officers report links that do nothing — check that the approved template's button prefix is
  exactly `{PUBLIC_ORIGIN}/set-password/` (Meta appends the token to it).
- The access log shows `login_link_used` for an account whose officer says they never used it.
