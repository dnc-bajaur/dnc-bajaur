-- 0021 — the software sends again (ADR-0014, M6-19, M6-22).
--
-- Two tables and an index. Neither table holds anything the event log holds, and that is the
-- rule they were designed against: the log is the record (ADR-0001), and these are the two
-- things it genuinely cannot be.
--
--------------------------------------------------------------------------------
-- 1. The provider's own id for a message
--------------------------------------------------------------------------------
--
-- A status webhook arrives carrying **Meta's** id and nothing else. To turn that into "attempt
-- a1b2 on incident X is now delivered", something has to map one to the other — and the event
-- log cannot, because the mapping does not exist yet at the moment the attempt is written. The
-- order of operations that INV-03 rests on is: record the attempt, *then* send, *then* record
-- the outcome. The provider's id is born in the middle of that.
--
-- So it lands here, and the events stay the record. `whatsapp_message` is a lookup table from
-- a provider id to an attempt, and every state change it learns about is still **appended to
-- the log** as `notification_delivered` or `notification_failed`. Delete this table and the
-- district loses the ability to interpret future webhooks; it loses no history.
--
-- Why `read` is a column here and never an event: ADR-0014 is explicit that a read receipt is
-- not the obligation being met. An officer who has disabled read receipts never produces one,
-- so a board built on blue ticks manufactures invisible failures at exactly the rate officers
-- value their privacy. It is carried because the district asked to see it, and it settles
-- nothing.

BEGIN;

CREATE TABLE IF NOT EXISTS whatsapp_message (
    -- Meta's id, e.g. wamid.HBgLOTIzMDA... . The primary key, because a webhook arrives with
    -- this and nothing else, and a duplicate delivery must be a no-op (webhooks retry).
    provider_message_id text        PRIMARY KEY,

    -- The attempt this message *is*. Not a foreign key: attempts live in the event log, which
    -- has no row to reference. The join is `payload->>'attemptId'`, and 0020 indexed it.
    attempt_id          uuid        NOT NULL,
    incident_id         uuid        NOT NULL,

    -- The number it was sent to, so a reply can be matched back to a conversation (M6-23).
    -- Stored as sent: digits, international form.
    to_phone            text        NOT NULL,

    -- queued -> sent -> delivered -> read, and `failed` off the side. Four states plus the
    -- failure, exactly as ADR-0014 decided, and **read is not one of the ones that count**.
    status              text        NOT NULL DEFAULT 'queued'
                                    CHECK (status IN ('queued','sent','delivered','read','failed')),
    -- Meta's own error code and title when it failed. Kept verbatim: a paraphrased provider
    -- error is a provider error nobody can look up.
    failure             text,

    sent_at             timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

-- "Which attempt does this webhook refer to" is the read path; "has this attempt already been
-- sent" is the write path. Both need this.
CREATE INDEX IF NOT EXISTS whatsapp_message_by_attempt ON whatsapp_message (attempt_id);

-- M6-23: an inbound reply arrives with a sender's number and no incident. It is matched to
-- that officer's most recent open attempt — and the screen says the match is **inferred**,
-- because it is.
CREATE INDEX IF NOT EXISTS whatsapp_message_by_phone ON whatsapp_message (to_phone, sent_at DESC);

--------------------------------------------------------------------------------
-- 2. The acknowledge link
--------------------------------------------------------------------------------
--
-- **This is the thing that meets the obligation** (ADR-0014, M6-22). One tap in a WhatsApp
-- message, and an attributable `acknowledged` event lands on the incident from an officer who
-- may have no account and may never sign in — which is most of the district's directory.
--
-- Three properties, all of them load-bearing:
--
--   * **Single use.** `used_at` is set on the first tap. A link that works twice is a link
--     that acknowledges an incident again a week later, out of somebody's message history.
--   * **The token is never stored**, only its SHA-256 — the same rule sessions follow
--     (migration 0003). A leaked database hands out no live acknowledgements.
--   * **It expires.** An acknowledgement three days later is not an acknowledgement, it is an
--     officer clearing their messages, and the SLA clock it would stop ran out long ago.
--
-- It carries `seat_id` **and** `person_id` as they were when the link was minted, so the
-- resulting event names the same actor the obligation did — a handover in between must not
-- silently attribute the acknowledgement to whoever holds the post now (ADR-0004).

CREATE TABLE IF NOT EXISTS ack_token (
    token_hash  bytea       PRIMARY KEY,
    attempt_id  uuid        NOT NULL,
    incident_id uuid        NOT NULL,
    seat_id     uuid,
    person_id   uuid,
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    used_at     timestamptz
);

CREATE INDEX IF NOT EXISTS ack_token_by_attempt ON ack_token (attempt_id);

INSERT INTO schema_migration (version) VALUES ('0021_whatsapp')
ON CONFLICT (version) DO NOTHING;

COMMIT;
