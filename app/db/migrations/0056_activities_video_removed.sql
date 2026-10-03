-- 0056 — Activities: a video that could not be used can be removed on its own (Bajaur, PLAN C3
-- open item). Until now a failed video stayed on its post, shown as failed, until the whole post
-- was deleted or expired. One new log line says who removed it.
--
-- ⚠️ No guard, no RAISE at boot: one widened CHECK.

BEGIN;

ALTER TABLE activity_log DROP CONSTRAINT IF EXISTS activity_log_type_check;
ALTER TABLE activity_log ADD CONSTRAINT activity_log_type_check CHECK (type IN (
    'posted',
    'photo_added',
    'video_added',
    'video_failed',
    'video_removed',      -- a video that could not be used was taken off its post
    'audio_added',
    'hidden',
    'restored',
    'deleted',
    'expired',
    'zip_downloaded',
    'unit_created',
    'unit_renamed',
    'unit_retired',
    'default_unit_set',
    'date_changed',
    'pending_approved',
    'pending_rejected',
    'pending_expired',
    'contact_added'
));

INSERT INTO schema_migration (version) VALUES ('0056_activities_video_removed')
ON CONFLICT (version) DO NOTHING;

COMMIT;
