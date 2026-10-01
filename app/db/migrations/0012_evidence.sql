-- 0012 — evidence: photographs and files attached to an incident (M1-05).
--
-- `resolved` and `closed` have carried an optional `evidenceIds` since migration 0001 and
-- those ids referenced nothing at all. This is the thing they point at.
--
--------------------------------------------------------------------------------
-- The bytes do not go in the database
--------------------------------------------------------------------------------
--
-- This table holds a **reference**: where the file is, how big it is, and its hash. The file
-- itself sits on disk under a configured directory.
--
-- Three reasons, and the third is the one that decided it:
--
--   * A logical dump is the district's backup mechanism (M0-37). Photographs inside it would
--     take the nightly dump from megabytes to gigabytes, and the thing that then fails is
--     the restore, at 02:00, when it is the only thing that matters.
--   * ADR-0011 sends those dumps out of the district to Google Cloud. Every photograph of
--     every emergency crossing that boundary nightly is a much larger disclosure than the
--     contact list, and it would happen without anybody deciding it.
--   * **Retention is unanswered** — R-11. Nothing here is deleted yet, deliberately, and
--     when the district does answer, deleting a file and appending a row saying it was
--     deleted is a change to two systems. Deleting bytes out of an append-only event log is
--     not possible at all, and should not be.
--
--------------------------------------------------------------------------------
-- What the hash is for
--------------------------------------------------------------------------------
--
-- Not deduplication. It is so that "this is the photograph the crew took" stays checkable
-- years later: the row says what the bytes should hash to, and anything that has been
-- swapped, truncated by a bad copy, or lost to a failing disk is detectable rather than
-- quietly wrong. Evidence nobody can verify is not evidence.

BEGIN;

CREATE TABLE IF NOT EXISTS evidence (
    evidence_id  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id  uuid        NOT NULL,

    -- As the device named it. Not trusted as a path — see `ops/evidence.ts`, which never
    -- uses it to decide where anything is written.
    filename     text        NOT NULL,
    content_type text        NOT NULL,
    byte_size    bigint      NOT NULL CHECK (byte_size > 0),
    sha256       text        NOT NULL CHECK (length(sha256) = 64),

    -- Relative to the configured evidence root, so moving the directory does not invalidate
    -- every row. Generated here, never taken from the client.
    stored_path  text        NOT NULL UNIQUE,

    /**
     * When the photograph was taken, if the device said so — as opposed to when it was
     * uploaded. Same distinction as occurred_at and recorded_at, for the same reason: a
     * photograph taken during the fire and uploaded when the crew got back to signal is one
     * fact, and treating the upload time as the capture time would misdate the evidence.
     */
    captured_at  timestamptz,
    uploaded_at  timestamptz NOT NULL DEFAULT now(),

    -- The seat, because authority attaches to the post (ADR-0004).
    uploaded_by_seat_id   uuid REFERENCES seat(seat_id),
    uploaded_by_person_id uuid REFERENCES person(person_id),

    caption      text
);

CREATE INDEX IF NOT EXISTS evidence_by_incident ON evidence (incident_id, uploaded_at);

-- No foreign key to an incident, and that is deliberate: `incident_event` is the record and
-- there is no `incident` table to point at. The id is the same one the events carry.

INSERT INTO schema_migration (version) VALUES ('0012_evidence')
ON CONFLICT (version) DO NOTHING;

COMMIT;
