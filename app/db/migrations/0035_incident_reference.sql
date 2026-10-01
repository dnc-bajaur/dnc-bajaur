-- 0035 — the district's own number.
--
-- Every incident already has an identity: a uuid, generated on the handset before any network
-- attempt, and that is exactly why it cannot be changed (ADR-0002 — it is what makes an offline
-- retry a no-op instead of a duplicate). It is also thirty-six characters of hexadecimal, and
-- the district reads it on the detail screen, on the printed report and nowhere they can use it:
--
--     Incident 297e3fba-accf-4298-808a-c3c4d01d3337
--
-- Nobody says that on a telephone. The control room in Bajaur rings people about emergencies all
-- night, and the identity this software gave them is one they cannot pronounce, cannot write on
-- a slip, and cannot ask an officer to quote back.
--
-- So the district gets a second identity, for humans: DNC-BAJAUR-1, DNC-BAJAUR-2, and on. It is a
-- **receipt number**, not a second primary key. The uuid is still what the log, the fold, the
-- outbox and every URL are built on; this table is the only thing that knows the number, and
-- nothing in the domain reads it.
--
-- Three properties, and each is here because losing it makes the number worse than none:
--
--   * **It is assigned once and never moves.** A number printed on a report that submitted
--     upward must still point at the same night a year later, so UPDATE and DELETE are refused
--     here the same way they are on `incident_event` — in the database, not in a code review.
--   * **It is gapless.** The district's stated reason for wanting it at all was that it doubles
--     as a count — "aik qesam ka counter bhi mil jaega 1 sai". A sequence would have been the
--     obvious mechanism and it burns a value on every rolled-back transaction, so the highest
--     number would slowly stop being the number of incidents. `MAX(seq) + n` under an advisory
--     lock costs one lock on a table this district writes to a few dozen times a month.
--   * **It is ordered by `recorded_at`, not `occurred_at`**, and this is the one that looks
--     wrong. Search is by occurrence for good reason (0019), but a counter cannot be: a report
--     captured offline in March and delivered in August would have to be inserted *between* two
--     numbers already given out, which an append-only counter cannot do. So the number says
--     "the Nth thing this district recorded", which is what a receipt number has always meant.
--
-- ⚠️ **Nothing here is in the event log**, deliberately. The number is not something anybody did
-- and not something the fold could produce — two servers folding the same events must not invent
-- two different numbers. It is assigned by the one primary (ADR-0019) after the events commit,
-- and an incident whose assignment failed simply has no number until the next sweep picks it up.
-- That ordering is INV-01: the emergency is stored first, and the convenience is a convenience.

BEGIN;

CREATE TABLE IF NOT EXISTS incident_reference (
    incident_id uuid        PRIMARY KEY,
    -- Bigint rather than int. The district will not reach two billion emergencies, but a
    -- counter that has to be widened is a counter that has to be re-issued.
    seq         bigint      NOT NULL UNIQUE,
    assigned_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT incident_reference_counts_from_one CHECK (seq >= 1)
);

--------------------------------------------------------------------------------
-- A number, once given out, never moves
--------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION incident_reference_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION
        'incident_reference is assign-once; % is not permitted. A number that has been printed on a report must keep pointing at the same incident.',
        TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS incident_reference_no_mutation ON incident_reference;
CREATE TRIGGER incident_reference_no_mutation
    BEFORE UPDATE OR DELETE ON incident_reference
    FOR EACH ROW
    EXECUTE FUNCTION incident_reference_reject_mutation();

-- TRUNCATE bypasses row triggers entirely, so it needs its own statement-level guard — the same
-- gap `incident_event` closed in 0001.
DROP TRIGGER IF EXISTS incident_reference_no_truncate ON incident_reference;
CREATE TRIGGER incident_reference_no_truncate
    BEFORE TRUNCATE ON incident_reference
    FOR EACH STATEMENT
    EXECUTE FUNCTION incident_reference_reject_mutation();

--------------------------------------------------------------------------------
-- Finding what has not been numbered yet
--------------------------------------------------------------------------------

-- The sweep asks one question — "which incidents have a `reported` event and no row here" —
-- and it asks it after every append that carried a new report. Without this it is a full scan
-- of the log on the write path of an emergency.
CREATE INDEX IF NOT EXISTS incident_event_reported_arrival
    ON incident_event (recorded_at, incident_id, event_id)
    WHERE type = 'reported';

INSERT INTO schema_migration (version) VALUES ('0035_incident_reference')
ON CONFLICT (version) DO NOTHING;

COMMIT;
