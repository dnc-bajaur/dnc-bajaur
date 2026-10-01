-- 0032 — what Meta says about THIS DISTRICT'S ACCOUNT, which it has been saying all along
--
-- WHAT THIS IS FOR
--
-- `api/dashboard.ts`'s condition panel has argued for this table since M6-25, in its own words:
-- the three rows on it are there because **they fail silently** — "an account out of credit, an
-- expired token, *a template somebody un-approved* — every one of them looks exactly like a quiet
-- night, and the district finds out on the night it matters."
--
-- It had no way to know about any of that. `Can send WhatsApp` was folded from `whatsapp_message`
-- — how many of OUR sends succeeded in the last day — which answers a different and weaker
-- question. A template Meta paused this morning shows as a perfectly quiet night until the first
-- send after it, and that send is at 02:00.
--
-- 🔴 AND META WAS ALREADY TELLING US. Read off the live app on 2026-08-21, the webhook
-- subscription carries `message_template_status_update`, `message_template_quality_update`,
-- `phone_number_quality_update`, `account_update`, `account_alerts`, `account_review_update` and
-- `security` — all of them, all `active`, pointing at this district's own endpoint. `readWebhook`
-- read `value.messages` and `value.statuses` and **never looked at `change.field`**, so every one
-- of those arrived, verified its signature, was answered 200, and was discarded without a line in
-- the log. This is the third instance of that exact shape, after the quick-reply tap (19 August)
-- and an officer's photograph (21 August): Meta sends it, nothing reads it, nobody finds out.
--
-- WHY A TABLE RATHER THAN THE EVENT LOG
--
-- ADR-0001 says the log is the record, and this is not the district's record — it is **somebody
-- else's system, described**. The same argument migration 0021 makes for `whatsapp_message` and
-- 0029 for the service window: a fact that CHANGES, held by Meta, which the log cannot represent
-- because there is no incident it belongs to. Drop this table and the district loses its ability
-- to see the state of its own account; it loses no history.
--
-- ⚠️ ONE ROW PER THING BEING DESCRIBED, LATEST WINS
--
-- The primary key is `(kind, subject)` and a notice UPSERTs over its predecessor. That is
-- deliberate and it is the difference between a **state** table and a log: what the district
-- needs on the wall is *is `district_message_v3` usable right now*, not every transition it has
-- ever made. Meta re-sends the current state on every change, so the newest row is the answer.
--
-- ⚠️ `noticed_at` IS WHEN WE HEARD, NEVER WHEN IT HAPPENED. Meta's payload carries no reliable
-- instant for the change itself, and inventing one would put a time in the district's record that
-- nobody established — the same distinction `occurred_at`/`recorded_at` draws on every event.

BEGIN;

CREATE TABLE IF NOT EXISTS whatsapp_account_state (
    -- Which kind of thing this is about. `template` names one approved template; `number` is the
    -- district's own phone number; `account` is the WABA itself. Three kinds because the three
    -- fail differently and lead to three different actions.
    kind        text        NOT NULL CHECK (kind IN ('template', 'number', 'account')),

    -- WHICH one. A template's name, or the number, or the account. Never null: a notice about
    -- nothing in particular is a row nobody can act on.
    subject     text        NOT NULL,

    -- Meta's own word for what happened — APPROVED, REJECTED, PAUSED, FLAGGED, UNFLAGGED, RED.
    -- Kept VERBATIM and never paraphrased, for the reason `readError` already gives about
    -- provider errors: this is the string somebody types into a Meta console to find out more.
    event       text        NOT NULL,

    -- How bad it is, decided from Meta's vocabulary at the point the webhook is read. Stored
    -- rather than derived on the way out, so a dashboard cannot disagree with a log line about
    -- the same notice — and so the mapping lives in one place (`ops/whatsapp.ts`) rather than in
    -- every screen that reads this.
    severity    text        NOT NULL CHECK (severity IN ('ok', 'warn', 'critical')),

    -- Meta's reason, when it gives one. Null is ordinary: an approval says nothing beyond itself.
    detail      text,

    -- When THIS SYSTEM heard it. See the note above on why there is no `occurred_at` here.
    noticed_at  timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (kind, subject)
);

-- The dashboard asks one question of this table — *is anything wrong right now* — and asks it on
-- every wall repaint, which is every twenty seconds in a control room that leaves it open.
CREATE INDEX IF NOT EXISTS whatsapp_account_state_by_severity
    ON whatsapp_account_state (severity)
    WHERE severity <> 'ok';

INSERT INTO schema_migration (version) VALUES ('0032_whatsapp_account_state')
ON CONFLICT (version) DO NOTHING;

COMMIT;
