-- 0057 — Activities: reactions and comments (ADR-0044 §4–§5, Bajaur — PLAN §4b G2).
--
--   1. `activity_reaction`: one mark per person per post — *Seen* or *Well done*.
--   2. `activity_comment`: what an account wrote under a post.
--   3. One new log line: a moderator removed somebody else's comment.
--
-- Both belong to their post and go with it (`ON DELETE CASCADE`): a hard delete, or the 30-day
-- rule. Like the rest of Activities, nothing here touches the incident event log or `evidence`,
-- and nothing here is ever sent on WhatsApp.
--
-- ⚠️ No guard, no RAISE at boot: two new tables and one widened CHECK.

BEGIN;

CREATE TABLE IF NOT EXISTS activity_reaction (
    post_id     uuid        NOT NULL REFERENCES activity_post(post_id) ON DELETE CASCADE,
    person_id   uuid        NOT NULL REFERENCES person(person_id),
    kind        text        NOT NULL CHECK (kind IN ('seen', 'well_done')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (post_id, person_id)
);

CREATE TABLE IF NOT EXISTS activity_comment (
    comment_id        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id           uuid        NOT NULL REFERENCES activity_post(post_id) ON DELETE CASCADE,
    author_person_id  uuid        NOT NULL REFERENCES person(person_id),
    body              text        NOT NULL CHECK (btrim(body) <> '' AND length(body) <= 1000),
    created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS activity_comment_by_post ON activity_comment (post_id, created_at);

ALTER TABLE activity_log DROP CONSTRAINT IF EXISTS activity_log_type_check;
ALTER TABLE activity_log ADD CONSTRAINT activity_log_type_check CHECK (type IN (
    'posted',
    'photo_added',
    'video_added',
    'video_failed',
    'video_removed',
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
    'contact_added',
    'comment_removed'     -- a moderator removed somebody else's comment
));

INSERT INTO schema_migration (version) VALUES ('0057_activities_reactions_comments')
ON CONFLICT (version) DO NOTHING;

COMMIT;
