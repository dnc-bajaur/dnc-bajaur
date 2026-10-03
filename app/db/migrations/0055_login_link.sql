-- 0055 — A sign-in link on WhatsApp (ADR-0043, Bajaur — phase E5).
--
--   1. `login_link`: a single-use link that lets an officer set their own password. Only the
--      token's SHA-256 is kept — the same rule as sessions and acknowledge links: a leaked
--      database hands out no live sign-in. How it was sent (and why it was not) is kept with it,
--      so the DC's screen can say so (INV-03).
--   2. Two new access-log lines: a link issued, and a link used.
--
-- ⚠️ No guard, no RAISE at boot: one new table, one widened CHECK.

BEGIN;

CREATE TABLE IF NOT EXISTS login_link (
    token_hash      bytea       PRIMARY KEY,
    person_id       uuid        NOT NULL REFERENCES person(person_id),
    issued_by       uuid        REFERENCES person(person_id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,
    used_at         timestamptz,
    -- A newer link for the same person, or the account leaving, cancels an unused one.
    revoked_at      timestamptz,
    -- 'whatsapp' (Meta accepted it), 'by_hand' (no login template: the DC was given the link),
    -- or 'failed' (Meta refused; `send_failure` says why).
    sent_via        text        NOT NULL CHECK (sent_via IN ('whatsapp', 'by_hand', 'failed')),
    send_failure    text
);

CREATE INDEX IF NOT EXISTS login_link_by_person ON login_link (person_id, created_at DESC);

ALTER TABLE access_event DROP CONSTRAINT IF EXISTS access_event_type_known;
ALTER TABLE access_event ADD CONSTRAINT access_event_type_known CHECK (type IN (
    'granted',
    'role_changed',
    'permission_set',
    'permission_cleared',
    'password_reset',
    'password_changed',
    'suspended',
    'reactivated',
    'removed',
    'session_revoked',
    'login_succeeded',
    'login_failed',
    'login_link_issued',  -- a sign-in link was made for a person (ADR-0043)
    'login_link_used'     -- the person set their password with it
));

INSERT INTO schema_migration (version) VALUES ('0055_login_link')
ON CONFLICT (version) DO NOTHING;

COMMIT;
