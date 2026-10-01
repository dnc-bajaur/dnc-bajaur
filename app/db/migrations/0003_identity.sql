-- 0003 — identity: people, seats, duty, sessions.
--
-- ADR-0004: authority attaches to a *seat*, never to a person. Officers in this district
-- transfer frequently, and a permission model tied to individuals breaks on every posting
-- order while quietly leaving departed officers with access.
--
-- The consequence for this schema: a person is only ever an authenticated human. What they
-- may *do* comes from the seat they hold right now, which is a row in duty_assignment with
-- an open time range. Revoke the assignment and the authority is gone the same instant,
-- with no cleanup step for anyone to forget.

BEGIN;

CREATE TABLE IF NOT EXISTS person (
    person_id     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name     text        NOT NULL,
    -- Phone is the practical identifier here. Email is not universal among field staff.
    phone         text        NOT NULL UNIQUE,
    password_hash text        NOT NULL,
    -- Set to disable an account without deleting the person; their history must survive.
    disabled_at   timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS seat (
    seat_id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    title           text        NOT NULL,
    department_id   uuid,
    tier            text        NOT NULL CHECK (tier IN ('station', 'tehsil', 'district', 'provincial')),
    -- Break-glass: acting outside the policy table. Always logged, always needs a reason.
    can_break_glass boolean     NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS duty_assignment (
    assignment_id uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    seat_id       uuid        NOT NULL REFERENCES seat(seat_id),
    person_id     uuid        NOT NULL REFERENCES person(person_id),
    from_at       timestamptz NOT NULL DEFAULT now(),
    -- NULL means currently held. Set it to end the assignment; authority ends with it.
    to_at         timestamptz,
    CONSTRAINT duty_range_sane CHECK (to_at IS NULL OR to_at > from_at)
);

-- One holder per seat at a time. Two people simultaneously holding "DPO Bajaur" would make
-- "who do I notify right now" unanswerable, which is the question the model exists to answer.
CREATE UNIQUE INDEX IF NOT EXISTS duty_one_current_holder_per_seat
    ON duty_assignment (seat_id)
    WHERE to_at IS NULL;

CREATE INDEX IF NOT EXISTS duty_by_person ON duty_assignment (person_id) WHERE to_at IS NULL;

CREATE TABLE IF NOT EXISTS session (
    session_id  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The token itself is never stored. A leaked database must not hand out live sessions.
    token_hash  bytea       NOT NULL UNIQUE,
    person_id   uuid        NOT NULL REFERENCES person(person_id),
    -- The seat held when the session began. Recorded so an event can name the seat as it
    -- was at the time, even if the roster changes later (ADR-0004).
    seat_id     uuid        REFERENCES seat(seat_id),
    created_at  timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    -- Revocation must be instant. A compromised account cannot wait for a token to expire.
    revoked_at  timestamptz
);

CREATE INDEX IF NOT EXISTS session_by_person ON session (person_id) WHERE revoked_at IS NULL;

INSERT INTO schema_migration (version) VALUES ('0003_identity')
ON CONFLICT (version) DO NOTHING;

COMMIT;
