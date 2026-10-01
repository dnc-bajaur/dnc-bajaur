# ADR-0034 — A category alert answers on its own template, with no acknowledge step

- **Status:** Accepted
- **Date:** 2026-09-03
- **Carries out:** [`backlog/whatsapp-response-workflow.md`](../../backlog/whatsapp-response-workflow.md)
  and the district's 2026-09-01 call; extends [ADR-0014](ADR-0014-the-software-sends-again.md)
- **Rests on:** [ADR-0028](ADR-0028-one-grid-two-fields.md) (the intake `{category, kind}` pair),
  the in-window response workflow (`domain/responseOptions.ts`, RW-01…12)

## The district's ask

The district designed an *Official WhatsApp Response Workflow* and, on 2026-09-01, chose to
deliver it as **one approved Meta template per emergency category** rather than as the
list-message-after-acknowledge flow that shipped in August:

> *"jis tarha whatsapp par 3 button ate hain … har category ka apna template ho, us par wo hi 3
> options hon jo us category ke liye theek hain, officer seedha wahi daba de — acknowledge alag se
> karne ki zarurat nahi."* And, on the numbered list the August flow wrote into the body: *"aik
> numbered list upar aur 3 button neeche — ye 'number type karo' jaisa lagta hai, jo quick reply
> nahi hai."*

Twelve `dnc_response_<category>` templates were submitted. Meta reclassified six to `MARKETING`;
they were resubmitted as `_v2` and were `PENDING` when this was built. The other six —
`fire`, `medical`, `road_accident`, `rescue`, `information`, `schedule` — are approved `UTILITY`.

## What was there

Every emergency, alert, advisory and order went out on **`district_emergency_v2`**: an
*Acknowledge* quick reply plus an *Open details* link. The tap on *Acknowledge* stopped the SLA
clock and opened the 24-hour window; `webhooks.ts` then sent the rich per-category list
(`listFor` → 4–5 options + an *Unable to Respond* branch: representative / on-leave / reason),
either in-thread or on the `/ack/` page. That in-window workflow is **unchanged** — it is still
the road for `district_emergency_v2`, for `district_message_img_v*` (a link opens no window), and
for every category the district has not switched on.

## The decision

### For a switched-on category, its `dnc_response_<category>` template is the first message

Three category-specific quick replies and **nothing else** — no *Acknowledge* button, no URL
link. The officer's **first tap is their response**: it acknowledges (stops the clock) and moves
the incident to Responded, or to Resolved for the label that means the matter is already dealt
with (the district's §9 Q4: *"Already being handlled ka matlab khatm hai"*). `reopened` exists
for the tap somebody regrets.

`webhooks.ts` reads the tapped label through `templateOptionFor(kind, category, label)` in
`domain/responseOptions.ts` — **scoped to the incident's own category**, because a label such as
*Coordinating w/ Dept* is on five of the templates — and runs it through the same
`applyResponseStage` / `askWhatFollows` machinery a `resp:` row runs, ending on the district's
closing sentence (`RESPONSE_THANKS`).

### What is switched on is one owner-controlled `.env` line

`WHATSAPP_RESPONSE_CATEGORIES` — a comma list of category slugs. Absent or empty is the ordinary
state and the one every installation is in: nothing changes. Only categories whose template is
**approved `UTILITY`** should be listed; `npm run doctor` grades each. The six `_v2` templates
stay off until the owner adds them after Meta approves, exactly as the owner decides which
`WHATSAPP_TEMPLATE_*` line points where (this ADR does not move live traffic on approval).

## Consequences

- **No separate acknowledge step for these categories.** The August workflow's diagram had one;
  this does not. The first tap does both jobs.
- **No *Unable to Respond* branch on these templates.** Three quick replies leave no room for the
  representative / on-leave / reason sub-flow. An officer who cannot respond **types a free
  reply**, which lands on the incident as their own words (the ordinary reply path is untouched).
  The owner accepted this trade for the six categories being wired.
- **The `records` value of each `btn 3` is the owner's to confirm** — the `resolved` cells
  (`Being Handled`, `Aid Already Provided`, `Already Addressed`, …) close an emergency from one
  tap. Listed in `backlog/for-the-owner.md`.
- **A photograph is unaffected.** None of the `dnc_response_*` templates carries a media header,
  so an alert with a photo still goes on `district_message_img_v*` with a link —
  `templateFor`'s picture branch runs before the category branch.
- **`domain/responseOptions.ts` carries the button labels twice** — once as `TEMPLATE_OPTIONS`
  (what a tap means) and once, in `ops/whatsappTemplate.ts`, as the submitted shape (`domain/`
  may not import `ops/`). `whatsappTemplate.test.ts` asserts the two agree label for label.
- **Server-only.** No `web/` change, no `CACHE` bump, no migration.

## Alternatives rejected

- **Keep acknowledge-first and send the 3 buttons as the follow-up.** Loses the district's whole
  point — that the officer answers in one tap without the template first asking "did you get
  this".
- **Reword the templates to match the rich `responseOptions.ts` catalogue.** The templates are
  already approved at Meta; rewording is another review queue, and the district chose the terse
  action-verb labels deliberately.
- **Automatic (any category with a `dnc_response_*` shape in code).** Would move live traffic
  onto a `PENDING` or `MARKETING` template the moment its shape existed. The owner holds the
  switch (ADR-0014's discipline).
