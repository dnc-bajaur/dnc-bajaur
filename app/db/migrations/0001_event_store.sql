-- 0001 — the event store.
--
-- ADR-0001: the event log is the record; state is a projection of it. That claim is only
-- true if the log is genuinely immutable, so append-only is enforced here, in the
-- database, rather than trusted to application code. A future maintainer writing a
-- well-intentioned UPDATE must hit a wall, not a code review.

BEGIN;

CREATE TABLE IF NOT EXISTS incident_event (
    -- Generated on the client, before any network attempt. This is what makes an offline
    -- retry after an ambiguous failure a no-op instead of a duplicate (ADR-0002, INV-08).
    event_id        uuid        PRIMARY KEY,

    incident_id     uuid        NOT NULL,
    type            text        NOT NULL,

    -- When it happened, per the reporter's device.
    occurred_at     timestamptz NOT NULL,
    -- When the server first accepted it. Diverges from occurred_at whenever a client was
    -- offline. Measurement uses occurred_at; escalation firing uses recorded_at. See
    -- docs/02-connectivity-ladder.md.
    recorded_at     timestamptz NOT NULL DEFAULT now(),

    actor_person_id uuid,
    -- The seat held at that moment. A later transfer must never rewrite history (ADR-0004).
    actor_seat_id   uuid,

    source_channel  text        NOT NULL,
    payload         jsonb       NOT NULL DEFAULT '{}'::jsonb,

    -- Events are immutable and will outlive several schema generations.
    payload_version smallint    NOT NULL DEFAULT 1,

    CONSTRAINT incident_event_occurred_not_future
        CHECK (occurred_at <= recorded_at + interval '1 day')
);

-- The fold reads an incident's whole history in order, every time.
CREATE INDEX IF NOT EXISTS incident_event_by_incident
    ON incident_event (incident_id, occurred_at, recorded_at, event_id);

-- The sync cursor: "give me everything recorded since X".
CREATE INDEX IF NOT EXISTS incident_event_by_recorded
    ON incident_event (recorded_at, event_id);

-- Finding late arrivals, which are the district's real connectivity signal.
CREATE INDEX IF NOT EXISTS incident_event_arrival_gap
    ON incident_event ((recorded_at - occurred_at))
    WHERE recorded_at - occurred_at > interval '15 minutes';

--------------------------------------------------------------------------------
-- Append-only enforcement
--------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION incident_event_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION
        'incident_event is append-only (ADR-0001); % is not permitted. Correct a mistake by appending a new event.',
        TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS incident_event_no_update ON incident_event;
CREATE TRIGGER incident_event_no_update
    BEFORE UPDATE OR DELETE ON incident_event
    FOR EACH ROW
    EXECUTE FUNCTION incident_event_reject_mutation();

-- TRUNCATE bypasses row triggers entirely, so it needs its own statement-level guard.
DROP TRIGGER IF EXISTS incident_event_no_truncate ON incident_event;
CREATE TRIGGER incident_event_no_truncate
    BEFORE TRUNCATE ON incident_event
    FOR EACH STATEMENT
    EXECUTE FUNCTION incident_event_reject_mutation();

--------------------------------------------------------------------------------
-- Schema history
--------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS schema_migration (
    version    text        PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO schema_migration (version) VALUES ('0001_event_store')
ON CONFLICT (version) DO NOTHING;

COMMIT;
