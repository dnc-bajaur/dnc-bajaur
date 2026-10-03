# The message template — submit this, exactly

**M6-26, revised for M7-24 on 2026-08-06 — before the district submitted anything.** This is what the district submits to Meta for approval, and it is what
`src/ops/whatsappTemplate.ts` sends. **The two are held together by a test and by
`npm run doctor`** — if you change one without the other, every send fails, and it fails at
02:00 on a real night rather than here.

Read the wording before submitting it. A template is approved **once** and changed slowly: a
second submission is another review queue, and in the meantime the district cannot send.

---

## What to fill in

In **WhatsApp Manager → Message templates → Create template**:

| Field | Value | Why |
|---|---|---|
| **Name** | `district_message_v3` | Lowercase and underscores only — Meta refuses anything else. **A name is fixed at approval and cannot be reused**, which is why this is `_v3`: each change of wording has been a new submission, never an edit. |
| **Category** | **Utility** | **Not Marketing.** A marketing template is rate limited as advertising and priced as advertising, so a district's emergency alerts would be throttled *and* cost more — and neither symptom points back at this field on the night it happens. |
| **Language** | English | `en` and `en_US` are different templates to Meta. Pick one and keep it. |
| **Header** | *(none)* | A header costs a line on a lock screen and says nothing the body does not. |
| **Footer** | *(none)* | Same. |

## The body — paste this

```
District Nerve Center — Bajaur

{{1}}

{{2}}

Please Acknowledge Below
```

**Two parameters, in this order.** Meta refuses the whole message when the count differs, so
this is not a detail:

| | What the software puts here | Sample for the approval form |
|---|---|---|
| `{{1}}` | The subject line — what this is | `EMERGENCY · Road accident · critical` |
| `{{2}}` | The message itself, in plain words | `Khar Road, near the bypass. Two vehicles, injuries reported.` |

Meta asks for a sample value for each. Use the ones above.

**🔴 The body may not end on a parameter, and this is an API rule rather than a reviewer's
opinion.** A body of name, `{{1}}`, `{{2}}` and nothing after was submitted on 2026-08-17 and
refused outright — `error_subcode 2388299`, *"Leading or trailing params not allowed — Variables
can't be at the start or end of the template."* **Nothing is created by that refusal**, so no name
is burned and no live template is touched, but it means **every template this district will ever
have must carry static text at both ends.** `Please Acknowledge Below` is that text, chosen by the
owner, and it is four words where the previous version was a 105-character sentence.

## The button — this is the important part

Add **one** button:

| Field | Value |
|---|---|
| Type | **Visit website** |
| URL type | **Dynamic** |
| URL | `https://dnc.YOURDOMAIN.pk/ack/{{1}}` — your own domain, and keep the `{{1}}` |
| Button text | `Acknowledge` |

**This button is the acknowledge link, and it is the thing that meets the obligation**
(ADR-0014). One tap from an officer who may hold no account and may never sign in — which is
most of the district's directory — produces an attributable `acknowledged` event on the
incident.

Without it, an officer has no way to confirm they have an emergency, and **every obligation
stays unmet on the board for ever.**

---

## Why the wording is what it is

**Nothing about a caller, ever.** These messages land on officers' personal handsets and stay in
their history for months. Capability 12 keeps citizen contact detail out of anything that leaves
this system, and a WhatsApp message leaves it entirely.

**No severity word in the fixed text.** "URGENT" in the template means the template cannot be
used for the routine half of the district's traffic, and one approved template is far easier to
keep than two. Everything that varies is a parameter.

**And no `Location:` either — this is the change of 2026-08-06, and it is the one worth
understanding.** The body used to read `Location: {{2}}`, which was right while the district
sent one kind of thing. The district then asked for **advisories, alerts and orders** to go out
the same way (M7-23). One word of fixed text would have made that impossible: an advisory about
a road closure has no location worth a labelled line, and an order has none at all — both would
have gone out saying `Location: place not stated`, which reads as broken software rather than
as a different kind of message.

So `{{2}}` is now just *the message*, and **one template carries all four kinds**. The district
submits one thing and waits once. What each kind actually says is decided in the software — in
code that can be changed in an afternoon, rather than in wording that needs Meta's review.
`{{1}}` carries the kind as a prefix (`ADVISORY · …`), and emergencies carry no prefix because
they are the majority and a word repeated on every message stops being read.

**The invitation to reply is gone from the words, and the reply itself still works.** Until
2026-08-17 the body ended *"If you cannot act on it, reply here and the control room will see it."*
The owner read that on a handset and asked for it out: it cost two lines on a lock screen at 02:00
and said nothing an officer did not already know. **Nothing about the mechanism changed** — a reply
is still a deliberate act by the person who was owed the message, still meets the obligation
exactly as the button does (M6-23), and is still the only way an officer who cannot act can say so
without ringing anybody. **The sentence was the advertisement, not the feature.**

**It says which district.** An officer in Bajaur may be on three WhatsApp groups about three
different things at 02:00, and the first line has to answer *what is this* before anything else.

---

## After it is approved

```
npm run doctor
```

It compares what Meta approved against what the software sends — the parameter count, the
category, the status, and whether the URL button exists — and names the fix for each mismatch
in a sentence somebody in a district office can act on.

**Do not skip this.** `CLAUDE.md` §5 says in as many words that the template approval is where
the surprise will be, and this check is the answer to that sentence.

---

## The two templates an officer can answer with a **tap** — approved 2026-08-19

Everything above describes a template whose only way to answer is a **link**, and answering it
means leaving WhatsApp: the handset opens an in-app browser, resolves the district's domain and
renders a page — on a district signal, at 02:00, on whatever handset an officer happens to own.
The tap is one gesture and everything after it is a network round trip that can fail. When it
fails the officer has answered and the board does not know.

A **quick reply** costs the officer no round trip. The tap arrives as an inbound message on the
district's own webhook — the same path a typed reply has travelled since M6-23 — so the answer
comes back over a connection the district controls.

**Two templates, because the district asks two different questions.**

### `district_emergency_v2` — emergencies, alerts, advisories, orders

Body: exactly the wording above, unchanged. Buttons, **in this order**:

| # | Type | Text | URL |
|---|---|---|---|
| 1 | **Quick reply** | `Acknowledge` | — |
| 2 | **Visit website**, Dynamic | `Open details` | `https://dnc.YOURDOMAIN.pk/ack/{{1}}` |

**🔴 The order is not cosmetic.** Meta identifies a button parameter by **position and nothing
else**, so the acknowledge token has to be sent to button **2** on this template. Sent to button 1
it attaches to the quick reply, and Meta refuses the message — **every** message on this template,
emergencies included, until somebody in a district office reads a provider error at 02:00. The
position lives in `src/ops/whatsappTemplate.ts` beside the name it belongs to, and `npm run
doctor` compares it against what Meta actually approved.

The link is labelled `Open details` rather than `Acknowledge` deliberately: with a quick reply
beside it, two buttons both claiming to acknowledge means an officer has to guess which one counts.

### `district_notice_v2` — meetings

Body: the same wording, ending `Please Answer Below`. Buttons: **three quick replies and no link
at all.**

| # | Type | Text |
|---|---|---|
| 1 | Quick reply | `Attending` |
| 2 | Quick reply | `Not attending` |
| 3 | Quick reply | `Sending someone` |

**"Not attending" is the point.** Until this template existed, an officer who could not come
either typed a reply or said nothing — and saying nothing is indistinguishable from not having
read it. `Sending someone` is the district's own third answer: a DEO sending a deputy has
answered the question, and a two-button template would have recorded them as absent.

**This template has no URL button, and that is load-bearing.** A send that attaches an acknowledge
token to it is naming a parameter for a button that does not exist, which Meta refuses outright.
The software decides both halves together, so no arrangement of `.env` can ask for one.

### Turning them on

```
WHATSAPP_TEMPLATE_EMERGENCY=district_emergency_v2
WHATSAPP_TEMPLATE_NOTICE=district_notice_v2
```

Each is read on its own — approval is per template and Meta reviews them separately, so the half
that is approved starts being used the day it is. **Leaving either blank breaks nothing**: those
messages keep going out on the ordinary template with one link, exactly as they did before.

### What stays on the old templates, and why

| kind | template | why |
|---|---|---|
| anything carrying a **photograph** | `WHATSAPP_TEMPLATE_IMAGE` | only an approved header can carry a picture, so a photograph goes wherever the district has a header template — see the section below |

⚠️ **The `schedule` / `other` row that used to sit here is gone — 2026-08-25.** It said those
went out on `WHATSAPP_TEMPLATE` because *"Attending"* is not an answer to a duty roster, which
is true and was never the question: the choice was between a template with **one link** and a
template with **Acknowledge plus a link**, and a duty roster is worth acknowledging. They now
go out on `WHATSAPP_TEMPLATE_EMERGENCY`, which needed no submission at all — its body is the
same two parameters and the same words. Nothing about attendance reaches them.

### What the district sees when somebody taps

The tap is recorded exactly as a reply is, because the evidence is exactly a reply's — a
deliberate act by the recipient, matched back to an obligation **by the number it came from**,
which is an inference either way (M7-30). It settles the obligation, it acknowledges the incident,
and it stops the clock where there is one.

What differs is the words on the incident: **`Tapped "Attending" on WhatsApp`**, not
*"Replied on WhatsApp: Attending"*. Nobody wrote that word — they chose it from the three the
district itself put in front of them, and the record should say so.

⚠️ **Re-wording a quick reply at Meta changes the district's record and breaks no send.** The tap
comes back as the label on the button, so a template quietly edited to say `Present` starts
writing `Present` onto incidents with nothing failing anywhere. The labels are held against the
approved template by `npm run doctor` for exactly that reason.

## `district_message_img_v3` — a photograph an officer can answer (submitted 2026-08-25)

Everything above this line can be typed into WhatsApp Manager. **This one cannot**, and that
is the first thing to know about it: Meta will not approve a media-header template without a
sample of the media, and the sample is uploaded through the Resumable Upload API. Submit it
with the tool, which builds the whole payload from the shape the software actually sends:

```
npm run submit:template -- --name district_message_img_v3            # shows, sends nothing
npm run submit:template -- --name district_message_img_v3 --confirm  # submits
```

### Why it exists

`district_message_img_v2` carries a picture and a **link**. A link is the one button that
answers nothing: Meta opens its 24-hour service window only when the officer **sends**
something, and a tap on a URL button sends nothing at all. So a photograph was the one kind of
message after which the district could put **no further message** in front of that officer —
no options, no follow-up question, no closing sentence. Everything else moved inside WhatsApp
on 2026-08-25 with no submission; this could not, because a media-header template cannot gain
a quick reply without a new approval.

It is `district_emergency_v2` with a picture on it and deliberately nothing else. Same body,
same two parameters, same `UTILITY`, same `en`.

| # | Type | Text | URL |
|---|---|---|---|
| — | **Header** | `IMAGE` | — |
| 1 | **Quick reply** | `Acknowledge` | — |
| 2 | **Visit website**, Dynamic | `Open details` | `https://dnc.YOURDOMAIN.pk/ack/{{1}}` |

🔴 **Its link is button TWO, where `_img_v2`'s is button ONE.** Meta identifies a button
parameter by position and nothing else. `templateFor` resolves the index from `shapeNamed()`
by the **configured name** for exactly this reason — sent to button 1, the token attaches to
the quick reply and Meta refuses **every** message on the template, the emergencies without
pictures too.

### Turning it on — a separate day, on purpose

```
WHATSAPP_TEMPLATE_IMAGE=district_message_img_v3
```

**Nothing switches by itself.** `npm run doctor` says when Meta has finished reviewing it and
stops there; until somebody changes that line, photographs go out on whatever it already names.
A rejection costs nothing either — `_img_v2` is not edited, not resubmitted and not deleted by
any of this, and goes on working exactly as it does today.

## `dnc_bajaur_login_link` — the sign-in link (ADR-0043, Bajaur E5)

Sent when the DC gives an officer a login (or a new link for a forgotten password). The officer
taps the button and chooses their own password; nobody else ever sees it.

- **Category:** Utility · **Language:** English (`en`)
- **Body** (one parameter, the officer's name):

```
District Nerve Center — Bajaur

{{1}}, a login to the district's Activities app has been made for you.

Tap the button below to choose your own password. The link works once and stops working after 3 days. If you did not expect this message, ignore it.
```

- **Button:** URL, dynamic, label **Set my password**, URL `{PUBLIC_ORIGIN}/set-password/{{1}}`
  — exactly that prefix; Meta appends the token to it.
- **Submit:** `npm run submit:template -- --name dnc_bajaur_login_link` (reads the same text from
  `src/ops/whatsappTemplate.ts`, so the two cannot differ).
- **Turn on:** once approved, set `WHATSAPP_TEMPLATE_LOGIN=dnc_bajaur_login_link` in `app/.env`.
  `npm run doctor` checks the approved template against this one. Until then the DC is shown the
  link to send by hand — "Give login" works either way.

## `dnc_bajaur_activity_response` — Respond, on an Activities post (ADR-0044, Bajaur G3)

Sent when the DC office presses **Respond** on an Activities post and the officer has **not**
written to the district number in the last 24 hours. Inside those 24 hours no template is used: a
plain message goes, and says the same thing.

- **Category:** Utility · **Language:** English (`en`)
- **Body** (two parameters: the date of the post, and the message):

```
District Nerve Center — Bajaur

Activities — a message from the DC office about your post of {{1}}:

{{2}}

This is not an emergency alert. To answer, reply to this message.
```

- **No button.** The officer answers by replying, and the answer appears under the post.
- **The message goes as one line.** Meta refuses a parameter with a line break in it, so the
  software joins the lines with spaces on this path.
- **Submit:** `npm run submit:template -- --name dnc_bajaur_activity_response`.
- **Turn on:** once approved, set `WHATSAPP_TEMPLATE_ACTIVITY=dnc_bajaur_activity_response` in
  `app/.env`. Until then, a Respond to an officer outside the 24 hours is **not sent**, and the
  screen says so.
- ⚠️ If Meta files it under *Marketing* instead of *Utility*, do not use it as it is — tell the
  developer; the wording will need changing (this happened to six other templates).
