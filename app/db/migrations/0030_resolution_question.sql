-- 0030 — the district asks a SECOND kind of question, and it is the one that closes an emergency
--
-- 0029 introduced `whatsapp_question` with one value in its CHECK, and said in its own comment
-- that the second one would be a new value here rather than a second table. This is that.
--
-- WHY RESOLVING NEEDS A QUESTION AT ALL
--
-- Every other step of the lifecycle is a tap: *On scene* says one thing and says all of it. A
-- resolution does not. `POST /ack/:token` has demanded a sentence since M9-27 — and the reason
-- is written into that route: **a resolution recorded as "resolved" answers nothing.** Six weeks
-- later the district is asked what happened at the Khar Road accident and the record says the
-- word "resolved", which is the same as having no record.
--
-- A button cannot carry that sentence. So the officer taps *Resolved*, the district asks what
-- happened, and their next typed message is the outcome — which is exactly the shape 0029 built
-- for the substitute's name, arriving at the second place that needs it.
--
-- ⚠️ WHY THE INCIDENT IS ON THE ROW AND NOT INFERRED FROM THE NUMBER
--
-- This matters more here than it did for a substitute's name. `lastMessageTo` matches an inbound
-- to the most recent alert sent to that handset, and states in three places that the match is a
-- guess. **A guess must not resolve an emergency.** An officer told about two emergencies ten
-- minutes apart, who taps *Resolved* on the first and then types a sentence, would otherwise
-- close the second — the one nobody has been to yet. The question carries its own incident, so
-- the sentence lands where the tap was.

BEGIN;

-- Dropped and recreated rather than added beside: a CHECK is not a list you append to, and two
-- constraints on one column would BOTH have to pass — so the old one-value check would silently
-- forbid every resolution while the new constraint sat there looking correct. Migration 0027
-- paid for this lesson on `presence_report.status`.
ALTER TABLE whatsapp_question DROP CONSTRAINT IF EXISTS whatsapp_question_asks_check;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_question_asks_known'
    ) THEN
        ALTER TABLE whatsapp_question
            ADD CONSTRAINT whatsapp_question_asks_known
            CHECK (asks IN ('substitute', 'resolution'));
    END IF;
END $$;

INSERT INTO schema_migration (version) VALUES ('0030_resolution_question')
ON CONFLICT (version) DO NOTHING;

COMMIT;
