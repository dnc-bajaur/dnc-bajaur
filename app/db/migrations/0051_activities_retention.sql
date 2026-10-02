-- 0051 — Activities: 30-day retention and the media backup (ADR-0039 §7–8, Bajaur — phase C2).
--
-- Three things, all on the Activities tables only:
--
--   1. Each media row remembers whether it has been copied to Bajaur's media bucket, and under
--      which object keys — so the nightly copy sends only what is new, and a delete knows what
--      to remove from the bucket.
--   2. A queue of bucket objects still to be removed. A hard delete (by a person or by the
--      30-day expiry) queues its keys in the same transaction that removes the rows, so a
--      delete can never be forgotten by the bucket even if the bucket is unreachable that night.
--   3. Two new kinds of log line: `expired` (deleted by the 30-day rule, no person) and
--      `zip_downloaded` (who took a copy of what was about to expire — INV-06).
--
-- ⚠️ No guard, no RAISE at boot: new nullable columns, a new table, and a widened CHECK.

BEGIN;

ALTER TABLE activity_media
    ADD COLUMN IF NOT EXISTS backup_key       text,
    ADD COLUMN IF NOT EXISTS thumb_backup_key text,
    ADD COLUMN IF NOT EXISTS backed_up_at     timestamptz;

-- What the nightly copy looks for: media not yet in the bucket, oldest first.
CREATE INDEX IF NOT EXISTS activity_media_not_backed_up
    ON activity_media (created_at) WHERE backed_up_at IS NULL;

CREATE TABLE IF NOT EXISTS activity_backup_removal (
    object_key         text        PRIMARY KEY,
    queued_at          timestamptz NOT NULL DEFAULT now(),
    -- The last reason the bucket refused, for `doctor` and the DC's warning. Null until it fails.
    last_error         text
);

ALTER TABLE activity_log DROP CONSTRAINT IF EXISTS activity_log_type_check;
ALTER TABLE activity_log ADD CONSTRAINT activity_log_type_check CHECK (type IN (
    'posted',
    'photo_added',
    'hidden',
    'restored',
    'deleted',
    'expired',          -- hard delete by the 30-day rule (ADR-0039 §7); actor is null
    'zip_downloaded',   -- a copy of the posts about to expire was downloaded
    'unit_created',
    'unit_renamed',
    'unit_retired',
    'default_unit_set'
));

INSERT INTO schema_migration (version) VALUES ('0051_activities_retention')
ON CONFLICT (version) DO NOTHING;

COMMIT;
