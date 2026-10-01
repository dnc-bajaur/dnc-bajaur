-- 0025 — the link that carries a file to a handset (M9-18)
--
-- WHY THIS EXISTS
--
-- Meta will only put a document on a template message if the template was approved with a
-- DOCUMENT/IMAGE header, and `district_message_v2` has none. Until one is approved, an
-- attachment reaches an officer as a LINK in the message body — and that link is opened on a
-- personal handset by somebody who may hold no account and may never sign in, which is most of
-- the district's directory (M0-51).
--
-- So it cannot be `/evidence/:id`: that route requires a session and authority over the
-- incident. And it must not be a public URL either, or every attachment the district ever sent
-- is readable by anyone who guesses a uuid, for ever.
--
-- The answer is the one M6-22 already established for acknowledgement: a token this system
-- minted, bound to the thing it grants and to the person it was minted for, that expires.
--
-- WHAT IS DIFFERENT FROM ack_token, AND WHY
--
-- `used_at` is deliberately ABSENT. An acknowledge link is single-use because acknowledging
-- twice is meaningless; a file link is not, because an officer will open the notice, close
-- WhatsApp, and open it again from the same message an hour later at the meeting. A file token
-- that died on first use would look exactly like a broken link, and the officer's next action
-- would be a telephone call to the control room.
--
-- It is bounded by TIME instead. `expires_at` is the whole of its safety, and the TTL is
-- deliberately longer than the acknowledge token's 24 hours: a meeting notice sent on Monday
-- for a meeting on Thursday must still open on Thursday.
--
-- `person_id` is recorded but NOT enforced on redemption. It answers "who was this minted for"
-- for the audit trail. Enforcing it would mean identifying the opener, and the only thing that
-- could identify them is the token itself — so the check would be circular, and it would break
-- the ordinary case of an officer forwarding a notice to their own department.

BEGIN;

CREATE TABLE IF NOT EXISTS file_token (
    token_hash  bytea       PRIMARY KEY,
    evidence_id uuid        NOT NULL REFERENCES evidence (evidence_id),
    incident_id uuid        NOT NULL,
    -- Who it was minted for. Provenance, never a gate — see the header.
    seat_id     uuid,
    person_id   uuid,
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    -- Every open, counted. Not to limit anything: an attachment nobody ever opened is a fact
    -- the district should be able to see, and it is the closest thing to a read receipt that
    -- ADR-0014 permits — because opening a file IS a deliberate act, unlike a blue tick.
    opened_count integer     NOT NULL DEFAULT 0,
    last_opened_at timestamptz
);

CREATE INDEX IF NOT EXISTS file_token_by_evidence ON file_token (evidence_id);

-- Expired rows are swept by the nightly job rather than left to accumulate. A token table that
-- only grows is a table somebody eventually truncates by hand at 02:00.
CREATE INDEX IF NOT EXISTS file_token_by_expiry ON file_token (expires_at);

INSERT INTO schema_migration (version) VALUES ('0025_file_tokens')
ON CONFLICT (version) DO NOTHING;

COMMIT;
