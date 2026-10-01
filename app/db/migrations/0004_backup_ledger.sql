-- M0-37: the backup ledger.
--
-- A backup that fails silently is not a backup, it is a belief. This table exists so that
-- "when did this last succeed" has an answer that does not involve anyone looking in a
-- folder — /health reads it, and a district with no successful backup in 24 hours says so
-- out loud rather than waiting to find out during a restore.
--
-- Same shape as a notification attempt (M0-32) and for the same reason: the attempt is
-- recorded *before* the work is tried, so a process killed mid-dump leaves a visible
-- `running` row rather than no row at all. A gap in this table is itself the signal.
--
-- Deliberately NOT append-only, unlike incident_event. ADR-0001 governs the record of what
-- happened in the district; this is operational telemetry about the machine holding it.
-- Making it immutable would mean two rows per backup and a join to answer the only question
-- anyone asks, which is "did last night's work".

CREATE TABLE IF NOT EXISTS backup_run (
    backup_run_id  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    started_at     timestamptz NOT NULL DEFAULT now(),
    finished_at    timestamptz,

    -- running | ok | failed. A row stuck in `running` means the process died mid-dump,
    -- which is a failure that no error handler was alive to record.
    status         text        NOT NULL DEFAULT 'running'
                               CHECK (status IN ('running', 'ok', 'failed')),

    path           text,
    bytes          bigint,

    -- So a restore can prove it is reading the same file that was written, rather than a
    -- truncated copy from an interrupted transfer.
    sha256         text,

    -- What the dump is *of*. A backup whose event count is lower than the live database's
    -- is not a good backup, however well the dump command exited.
    event_count    bigint,

    error          text
);

-- The only query that matters at 02:00: when did this last actually work.
CREATE INDEX IF NOT EXISTS backup_run_success_idx
    ON backup_run (finished_at DESC)
    WHERE status = 'ok';

INSERT INTO schema_migration (version) VALUES ('0004_backup_ledger')
ON CONFLICT (version) DO NOTHING;
