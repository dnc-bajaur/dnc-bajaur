-- 0026 — the acknowledge link grows into a lifecycle link (M9-27)
--
-- WHY THIS IS A COLUMN AND NOT A SECOND TABLE
--
-- The district asked to move an emergency through Issued → Acknowledged → Responded → Resolved
-- from the message itself. Meta approved ONE url button on `district_message_v2` and the owner's
-- standing rule is that coding never waits on a template review, so a second and third button
-- are not available and will not be asked for.
--
-- What is available is the page the first button already opens. An officer who has just tapped
-- acknowledge is one whose identity THIS SYSTEM established, with a token IT minted, seconds ago
-- — which is a far better claim than a phone number, and this codebase already refuses to trust
-- a phone number because two officers in Bajaur share one (migration 0006, Q-19). So the page
-- mints the next tokens and offers them as links on itself.
--
-- Those tokens want every property `ack_token` already has: hashed at rest, single-use in one
-- statement, expiring, and carrying the seat and person captured AT MINT rather than resolved
-- later (ADR-0004 — a handover between the message going out and the tap arriving must not
-- reattribute the act). A second table would be that same column list with a different name, a
-- second sweep to write, and a second place to audit when somebody asks how a resolution was
-- authorised. One table, one redemption path, one thing to get right.
--
-- WHY THERE IS NO 'issued' STAGE
--
-- A token can only ever move an incident FORWARD, and nothing is ever moved to Issued: that is
-- where an emergency starts. Allowing the value would create a token whose only possible use is
-- to walk a record backwards, which `domain/stages.ts` refuses anyway — and a constraint that
-- permits what the code forbids is an invitation to somebody who reads only one of them.
--
-- WHY EXISTING ROWS BECOME 'acknowledge'
--
-- Every token minted before today is an acknowledge link, and some of them are live in officers'
-- message history right now. The default is what makes this migration safe to run against the
-- district's own data mid-flight: nothing in flight changes meaning.

BEGIN;

ALTER TABLE ack_token
    ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'acknowledge';

-- Written as a DO block rather than a bare ADD CONSTRAINT because this file must be safe to
-- re-run: `migrate` applies by version, but a half-applied migration recovered by hand is a
-- thing that happens at 02:00, and IF NOT EXISTS has no equivalent for constraints here.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ack_token_stage_known'
    ) THEN
        ALTER TABLE ack_token
            ADD CONSTRAINT ack_token_stage_known
            CHECK (stage IN ('acknowledge', 'respond', 'resolve'));
    END IF;
END $$;

INSERT INTO schema_migration (version) VALUES ('0026_lifecycle_tokens')
ON CONFLICT (version) DO NOTHING;

COMMIT;
