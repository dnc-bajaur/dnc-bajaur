-- 0054 — Activities: voice notes, and messages from unknown numbers (ADR-0041, Bajaur — phase E1).
--
--   1. `activity_media` may hold a voice note (`audio`), sent by WhatsApp. Ready on arrival, like
--      a photo.
--   2. `activity_inbound_media` may hold a voice note, or a **message** (`text`) — the words, a
--      file's name or a place an unknown number sent. A message has no file, so its file columns
--      are empty; every other kind still has them all.
--   3. Two new log lines: a number added to the Directory from the Pending list, and a voice note
--      added to a post.
--
-- ⚠️ No guard, no RAISE at boot: widened CHECKs, one new nullable column, NOT NULL dropped where a
-- CHECK takes its place.

BEGIN;

ALTER TABLE activity_media DROP CONSTRAINT IF EXISTS activity_media_kind_check;
ALTER TABLE activity_media ADD CONSTRAINT activity_media_kind_check
    CHECK (kind IN ('photo', 'video', 'audio'));

ALTER TABLE activity_inbound_media DROP CONSTRAINT IF EXISTS activity_inbound_media_kind_check;
ALTER TABLE activity_inbound_media ADD CONSTRAINT activity_inbound_media_kind_check
    CHECK (kind IN ('photo', 'video', 'audio', 'text'));

ALTER TABLE activity_inbound_media
    ADD COLUMN IF NOT EXISTS body text CHECK (body IS NULL OR length(body) <= 4000),
    ALTER COLUMN content_type DROP NOT NULL,
    ALTER COLUMN byte_size    DROP NOT NULL,
    ALTER COLUMN sha256       DROP NOT NULL,
    ALTER COLUMN stored_path  DROP NOT NULL;

-- A message has words and no file; everything else has a file and all that describes it.
ALTER TABLE activity_inbound_media DROP CONSTRAINT IF EXISTS activity_inbound_media_file_or_words;
ALTER TABLE activity_inbound_media ADD CONSTRAINT activity_inbound_media_file_or_words CHECK (
    (kind = 'text' AND body IS NOT NULL AND stored_path IS NULL)
    OR (kind <> 'text' AND stored_path IS NOT NULL AND content_type IS NOT NULL
        AND byte_size IS NOT NULL AND sha256 IS NOT NULL)
);

ALTER TABLE activity_log DROP CONSTRAINT IF EXISTS activity_log_type_check;
ALTER TABLE activity_log ADD CONSTRAINT activity_log_type_check CHECK (type IN (
    'posted',
    'photo_added',
    'video_added',
    'video_failed',
    'audio_added',        -- a voice note joined a post (WhatsApp)
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
    'contact_added'       -- the DC added a number to the Directory from the Pending list
));

INSERT INTO schema_migration (version) VALUES ('0054_activities_voice_and_messages')
ON CONFLICT (version) DO NOTHING;

COMMIT;
