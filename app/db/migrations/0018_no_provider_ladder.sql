-- 0018 — the software does not make the call (M5).
--
-- Migration 0013 created `channel_ladder`: an ordered list of ways for the *system* to reach a
-- seat — WhatsApp Business, a voice provider, an SMS gateway, and a GSM modem in the DC
-- office. This drops it.
--
-- Why. The owner, 2026-08-03, on reading what M3 had built:
--
--   > es ka ye matlab nhe hai k software call karega, jis k lye tum nai itne saare chez deye
--   > hue hain, es ka ye matlab tha k ju banda alert jare karega ya escalate karega etc etc un
--   > ko mutalqa number mil jaye and us pr click kare tou contact karne ka channel selection
--   > mai ho … es mai Meta business account, telephony ya SMS gateway ki koi zarurt nhe hai
--
-- None of it had been asked for. What was wanted is that an officer who is about to escalate
-- **sees the number** and can open WhatsApp, the dialler or messages on their own handset.
-- That is `GET /contacts/department/:id` and the "Reach them" control, and it needs no
-- account with anybody.
--
-- It is also the better design, and not only the smaller one. A chain of providers fails in
-- ways nobody sees — a template unapproved, a gateway out of credit, a modem with no signal —
-- and every one of those is discovered on the night it matters. An officer who dialled a
-- number knows within ten seconds whether it rang.
--
--------------------------------------------------------------------------------
-- What stays
--------------------------------------------------------------------------------
--
-- **The in-app inbox, and every attempt recorded against it.** `notification_attempt` and the
-- `notified` / `notification_delivered` / `notification_failed` events are untouched. They are
-- what INV-03 is measured against — *a notification failure is never invisible* — and the
-- in-app channel is the only one whose "delivered" ever meant a human collected the message
-- rather than a queue accepted it.
--
-- Dropped rather than left in place. An unused table that an unused screen used to write to is
-- a feature the next person will assume is load-bearing, and this one would have them
-- procuring a Meta business account.

BEGIN;

DROP TABLE IF EXISTS channel_ladder;

-- `channel_ladder` can no longer be the subject of a change. Rows already written keep their
-- text: the log is append-only (ADR-0001), and a constraint that rejected its own history
-- would be a constraint that lies about what happened.
ALTER TABLE config_event DROP CONSTRAINT IF EXISTS config_event_subject_known;
ALTER TABLE config_event
    ADD CONSTRAINT config_event_subject_known
    CHECK (subject IN ('department', 'routing_signal', 'sla_target', 'seat', 'person', 'duty',
                       'resource', 'channel_ladder', 'utility', 'wall_screen',
                       'district_fact', 'district_alert'));

INSERT INTO schema_migration (version) VALUES ('0018_no_provider_ladder')
ON CONFLICT (version) DO NOTHING;

COMMIT;
