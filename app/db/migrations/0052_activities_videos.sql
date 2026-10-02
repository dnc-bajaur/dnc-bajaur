-- 0052 — Activities: videos (ADR-0039 §3–4, Bajaur — phase C3).
--
-- A video is an `activity_media` row of kind `video`, and it has a life a photo does not:
--
--   uploading  — the phone is sending it in chunks; `received_bytes` of `byte_size` have arrived
--                in `upload_path`. Resumable: the phone asks how much arrived and carries on.
--   processing — every byte is here; the converter (`jobs/activitiesVideo.ts`) has yet to turn it
--                into 720p H.264 with ffmpeg.
--   ready      — `stored_path` is the converted MP4, `thumb_path` its poster frame, and the
--                original is deleted. Only a ready video is shown, zipped or backed up.
--   failed     — ffmpeg refused it, or it is longer than three minutes; `failure` says which.
--                The original is deleted; `npm run doctor` lists these.
--
-- Photos are `ready` from the moment they arrive, which is what the default gives every existing
-- row. A photo's `sha256` is known when its row is written; a video's only once it is converted,
-- so the column may now be empty until then.
--
-- ⚠️ No guard, no RAISE at boot: new columns with safe defaults, widened CHECKs, one new index.

BEGIN;

ALTER TABLE activity_media DROP CONSTRAINT IF EXISTS activity_media_kind_check;
ALTER TABLE activity_media ADD CONSTRAINT activity_media_kind_check
    CHECK (kind IN ('photo', 'video'));

ALTER TABLE activity_media
    ADD COLUMN IF NOT EXISTS status           text        NOT NULL DEFAULT 'ready',
    -- While uploading: how many of `byte_size` bytes have arrived.
    ADD COLUMN IF NOT EXISTS received_bytes   bigint,
    -- The original as it arrives, relative to the Activities root. Gone once converted or failed.
    ADD COLUMN IF NOT EXISTS upload_path      text        UNIQUE,
    ADD COLUMN IF NOT EXISTS duration_seconds numeric(8, 2),
    -- Why a video failed, in words an operator can act on.
    ADD COLUMN IF NOT EXISTS failure          text,
    -- When the status last changed (or the last chunk arrived) — finds abandoned uploads.
    ADD COLUMN IF NOT EXISTS status_at        timestamptz NOT NULL DEFAULT now();

-- A photo was ready when it arrived: without this, the backup's "not copied for over a day"
-- warning would start counting again from today for every photo already here.
UPDATE activity_media SET status_at = created_at WHERE kind = 'photo';

ALTER TABLE activity_media DROP CONSTRAINT IF EXISTS activity_media_status_check;
ALTER TABLE activity_media ADD CONSTRAINT activity_media_status_check
    CHECK (status IN ('uploading', 'processing', 'ready', 'failed'));

-- A photo is always ready; a ready file always has its hash.
ALTER TABLE activity_media DROP CONSTRAINT IF EXISTS activity_media_photo_ready;
ALTER TABLE activity_media ADD CONSTRAINT activity_media_photo_ready
    CHECK (kind = 'video' OR status = 'ready');

ALTER TABLE activity_media ALTER COLUMN sha256 DROP NOT NULL;
ALTER TABLE activity_media DROP CONSTRAINT IF EXISTS activity_media_sha256_check;
ALTER TABLE activity_media ADD CONSTRAINT activity_media_sha256_check
    CHECK (sha256 IS NULL OR length(sha256) = 64);
ALTER TABLE activity_media DROP CONSTRAINT IF EXISTS activity_media_ready_hashed;
ALTER TABLE activity_media ADD CONSTRAINT activity_media_ready_hashed
    CHECK (status <> 'ready' OR sha256 IS NOT NULL);

-- What the converter and the housekeeping look for. Ready rows — nearly all of them — are not in it.
CREATE INDEX IF NOT EXISTS activity_media_unfinished
    ON activity_media (status, status_at) WHERE status <> 'ready';

ALTER TABLE activity_log DROP CONSTRAINT IF EXISTS activity_log_type_check;
ALTER TABLE activity_log ADD CONSTRAINT activity_log_type_check CHECK (type IN (
    'posted',
    'photo_added',
    'video_added',      -- every byte of a video arrived; conversion follows
    'video_failed',     -- the converter refused it (actor is null) — the reason is in `detail`
    'hidden',
    'restored',
    'deleted',
    'expired',
    'zip_downloaded',
    'unit_created',
    'unit_renamed',
    'unit_retired',
    'default_unit_set'
));

INSERT INTO schema_migration (version) VALUES ('0052_activities_videos')
ON CONFLICT (version) DO NOTHING;

COMMIT;
