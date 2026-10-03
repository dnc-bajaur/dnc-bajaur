-- 0058 — Activities: Respond (ADR-0044 §6–§7, Bajaur — PLAN §4b G3).
--
-- One table holds both halves of the exchange under a post:
--
--   * `out` — a message the DC office sent to the person who made the post, over the district's
--     WhatsApp number: who sent it, how (inside the 24-hour window, or on the template), Meta's
--     id for it, and what Meta has since said happened to it (INV-03);
--   * `in`  — that person's answer: which of our messages it answers, whether that was matched by
--     WhatsApp's own reply or by time, and a photo or a voice note if one came with it.
--
-- This is not the incident record and never becomes it: no event, no obligation, no SLA. It
-- belongs to its post and goes with it (`ON DELETE CASCADE`); an answer's file lives in the
-- post's own folder, which is removed with the post.
--
-- ⚠️ No guard, no RAISE at boot: one new table and one widened CHECK.

BEGIN;

CREATE TABLE IF NOT EXISTS activity_response (
    response_id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id             uuid        NOT NULL REFERENCES activity_post(post_id) ON DELETE CASCADE,
    direction           text        NOT NULL CHECK (direction IN ('out', 'in')),
    -- The officer's number, digits in international form — where an `out` went, where an `in`
    -- came from.
    phone               text        NOT NULL,
    -- What was typed. An answer that is only a photo or a voice note has none.
    body                text        NOT NULL CHECK (length(body) <= 4000),
    created_at          timestamptz NOT NULL DEFAULT now(),

    -- out ---------------------------------------------------------------------
    actor_person_id     uuid        REFERENCES person(person_id),
    via                 text        CHECK (via IN ('session', 'template')),
    -- Null when Meta refused the send outright: there is then nothing for a webhook to name.
    provider_message_id text        UNIQUE,
    status              text        CHECK (status IN ('sent', 'delivered', 'read', 'failed')),
    failure             text,
    status_at           timestamptz,

    -- in ----------------------------------------------------------------------
    in_reply_to         uuid        REFERENCES activity_response(response_id) ON DELETE CASCADE,
    -- 'reply': the officer used WhatsApp's reply on our message. 'latest': plain words, matched to
    -- the last Respond sent to that number — an inference, and shown as one.
    matched_by          text        CHECK (matched_by IN ('reply', 'latest')),
    -- Meta's id for the officer's message: a retried webhook must not keep it twice.
    wa_message_id       text        UNIQUE,
    media_kind          text        CHECK (media_kind IN ('photo', 'audio')),
    content_type        text,
    -- Relative to the Activities root, chosen by the server.
    stored_path         text        UNIQUE,
    sha256              text,
    byte_size           bigint,

    CONSTRAINT activity_response_shape CHECK (
        (direction = 'out' AND actor_person_id IS NOT NULL AND via IS NOT NULL
            AND status IS NOT NULL AND btrim(body) <> '')
        OR (direction = 'in' AND matched_by IS NOT NULL
            AND (btrim(body) <> '' OR media_kind IS NOT NULL))
    ),
    CONSTRAINT activity_response_file CHECK (
        (media_kind IS NULL AND stored_path IS NULL)
        OR (media_kind IS NOT NULL AND stored_path IS NOT NULL AND content_type IS NOT NULL
            AND sha256 IS NOT NULL AND byte_size IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS activity_response_by_post ON activity_response (post_id, created_at);
-- "The last Respond sent to this number", asked on every plain inbound message.
CREATE INDEX IF NOT EXISTS activity_response_out_by_phone
    ON activity_response (phone, created_at DESC) WHERE direction = 'out';

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
    'comment_removed',
    'responded'           -- the DC office sent a message to a post's sender
));

INSERT INTO schema_migration (version) VALUES ('0058_activities_responses')
ON CONFLICT (version) DO NOTHING;

COMMIT;
