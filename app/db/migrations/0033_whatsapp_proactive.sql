-- 0033 — what the district has ALREADY said inside a service window, so it never says it twice
--
-- WHAT THIS IS FOR
--
-- Every WhatsApp message this system has ever sent was a **reply**: an alert somebody dispatched,
-- or an answer to something an officer typed. Meta's 24-hour service window has been open on
-- replying handsets since migration 0029 and the district has only ever used it to respond.
--
-- Phase 5 spends it deliberately, in three places — a nudge before the ladder climbs over an
-- officer's head, a word when the emergency they were called to is closed, and one summary a day
-- for the administration. All three are free-form, none of them needs a template, and every one
-- of them is a message NOBODY ASKED FOR. That is the whole reason this table exists.
--
-- WHY A TABLE, AND WHY NOT THE EVENT LOG
--
-- ADR-0001 says the log is the record, and each of these three is a **claim about what this
-- software has already done to a handset**, not a fact about an emergency. The same argument
-- 0021 makes for `whatsapp_message`, 0029 for the window and 0032 for Meta's own notices.
--
-- 🔴 AND THE COST OF GETTING IT WRONG IS THE ONE FAILURE THIS PRODUCT CANNOT AFFORD.
-- The scheduler ticks every fifteen seconds. An unacknowledged emergency is a standing condition,
-- not an event — so a nudge decided from state alone and nothing else would be sent again on the
-- next tick, and the next, four times a minute, to an officer at 02:00. That is INV-08's
-- notification storm arriving through a door nobody had built yet. Escalation is idempotent
-- because the LADDER records where it got to; a nudge has no ladder, so it needs this.
--
-- ⚠️ THE ROW IS WRITTEN BEFORE THE SEND, NEVER AFTER — `recordQuestion`'s rule, and INV-03's
-- order of operations. A row for a message that then failed to send costs the officer one nudge
-- they were not going to get anyway; a send recorded afterwards, interrupted by a restart between
-- the two, is the same message every fifteen seconds until somebody notices.
--
-- ⚠️ AND IT IS CLAIMED WITH `ON CONFLICT DO NOTHING`, WHICH IS WHY THE PRIMARY KEY IS THE WHOLE
-- OF IT. Two instances may run a pass at once — the scheduler takes an advisory lock, but this
-- table must be correct without depending on that, because the lock is an optimisation and the
-- primary key is a guarantee. The insert IS the decision: one row back means this instance won
-- and sends; zero means somebody already has.

BEGIN;

CREATE TABLE IF NOT EXISTS whatsapp_proactive (
    -- Which of the three. Named rather than numbered so a log line and a row read the same, and
    -- CHECKed so a fourth kind is a migration rather than a typo that silently never dedupes.
    kind      text        NOT NULL CHECK (kind IN ('nudge', 'closed', 'summary')),

    -- WHAT it was about. The incident id for a nudge and for a closing word; the district's own
    -- DATE — `2026-08-21`, never an instant — for a summary, because a summary is about a day and
    -- Bajaur's day is not UTC's (M9-49, ADR-0020).
    subject   text        NOT NULL,

    -- WHICH HANDSET. Part of the key rather than a column beside it: two officers on one
    -- emergency are two people to nudge, and a key without the number would silence the second.
    phone     text        NOT NULL,

    -- When this system decided to send. Not when Meta accepted it — that is `whatsapp_message`'s
    -- to say, and this row is deliberately written before the send so it cannot claim delivery.
    sent_at   timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (kind, subject, phone)
);

-- The one question anything asks of this table beyond the key: what has this pass already done
-- today. Used by the summary, which is keyed on a date and looks nothing up by incident.
CREATE INDEX IF NOT EXISTS whatsapp_proactive_by_time ON whatsapp_proactive (sent_at DESC);

INSERT INTO schema_migration (version) VALUES ('0033_whatsapp_proactive')
ON CONFLICT (version) DO NOTHING;

COMMIT;
