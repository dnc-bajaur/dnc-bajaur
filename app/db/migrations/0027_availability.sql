-- 0027 — five answers to "where are you", and whose answer it is (M9-31, M9-32)
--
-- TWO CHANGES, AND THE SECOND IS THE ONE WORTH READING
--
-- FIVE STATUSES. The district asked for one list: present · absent · office · field · leave.
-- The three that already exist keep their exact spellings, so every row already in Bajaur's
-- database still reads correctly and nothing is migrated. `present` is not a synonym for
-- `office` — it is the honest answer when somebody is working and nobody knows where, and
-- collapsing it into `office` would put an officer at a desk they are not at.
--
-- WHOSE AVAILABILITY IT IS. `presence_report` has always been keyed to a SEAT, and a seat is a
-- post, not a person. ADR-0004 draws that line deliberately: authority attaches to the post,
-- because the post is what an emergency is routed to and what has a duty at 02:00.
--
-- But *where somebody is* is not a fact about a post. It is a fact about a person. "AAC Baka
-- Khel is on leave until Thursday" is nonsense on its face — the post is not on leave, the
-- officer holding it is, and if they hand over on Tuesday the post is staffed while the record
-- still says leave. That is exactly the permanent grey box M9-35 exists to prevent, arriving by
-- a different door.
--
-- So the report now records BOTH: the post it was made about, and the person it is about. The
-- seat stays because that is how the dashboard reads it and how a department scopes what it may
-- set. The person is added because that is what the claim is actually about.
--
-- Nullable, and it has to be. A post with nobody in it can still be reported on — "nobody holds
-- this, and nobody is coming" is a real and important thing for a district to be able to say,
-- and it is the state ADR-0004's escalation ladder exists to surface.
--
-- `reported_by` is a THIRD person and stays what it was: whoever typed it. A department clerk
-- recording that the AAC is on leave is not the AAC. Flattening the two would leave the district
-- unable to answer "who said he was on leave?", which is the first question asked when he says
-- he was not.

BEGIN;

ALTER TABLE presence_report
    ADD COLUMN IF NOT EXISTS person_id uuid REFERENCES person (person_id);

-- Dropped and recreated rather than added beside: a CHECK is not a list you append to, and two
-- constraints on one column would both have to pass, so the old three-value one would silently
-- forbid the two new answers while the new constraint sat there looking correct.
ALTER TABLE presence_report DROP CONSTRAINT IF EXISTS presence_report_status_check;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'presence_report_status_known'
    ) THEN
        ALTER TABLE presence_report
            ADD CONSTRAINT presence_report_status_known
            CHECK (status IN ('present', 'absent', 'office', 'field', 'leave'));
    END IF;
END $$;

-- Reading one officer's availability across a handover means asking by person, not by seat.
CREATE INDEX IF NOT EXISTS presence_report_by_person
    ON presence_report (person_id, reported_at DESC);

-- AND ONE MORE STAGE ON THE LIFECYCLE TOKEN (M9-34)
--
-- The officer who has just tapped acknowledge is the one person whose identity this system
-- established itself, seconds ago, with a token it minted. That is what makes "tell us where you
-- are, without logging in" possible WITHOUT trusting a phone number — which this codebase already
-- refuses to do, because two officers in Bajaur share one (migration 0006, Q-19).
--
-- So the lifecycle page carries an availability form, and it spends its own single-use token
-- rather than the one that moves the emergency. Two different acts, two different tokens: an
-- officer who says "I am in the field" has not resolved anything.

ALTER TABLE ack_token DROP CONSTRAINT IF EXISTS ack_token_stage_known;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ack_token_stage_known_v2'
    ) THEN
        ALTER TABLE ack_token
            ADD CONSTRAINT ack_token_stage_known_v2
            CHECK (stage IN ('acknowledge', 'respond', 'resolve', 'availability'));
    END IF;
END $$;

INSERT INTO schema_migration (version) VALUES ('0027_availability')
ON CONFLICT (version) DO NOTHING;

COMMIT;
