-- 0015 — what a wall screen shows, and what it signs in as (M4, ADR-0013).
--
-- Three things arrive together because they exist for one reason: the DC office and the AC
-- Headquarter want a screen on the wall that answers "what is the state of the district right
-- now", and two of its panels ask for facts the system has never held.
--
--   * `utility_report`  — is the electricity on? the water? the gas? the internet?
--   * `presence_report` — is the AAC in his office, in the field, or on leave?
--   * `wall_screen`     — the identity a television signs in as, which is not a person's
--
-- The first two are **department-reported**, in the owner's sense: a department manages its
-- own data, and nobody else types on its behalf. PESCO says whether PESCO is up.
--
--------------------------------------------------------------------------------
-- Why these are reports, not states
--------------------------------------------------------------------------------
--
-- The tempting shape is a column: `utility.status = 'normal'`. It is wrong for the same
-- reason a board table would be wrong (ADR-0001). A status column answers "what is it now"
-- and silently destroys "since when, and who says so" — which on a wall screen is the whole
-- question. ADR-0013 §3: a green dot with no age is silence wearing the costume of an answer.
--
-- So each of these is an append-only stream of **reports**, and the current value is the
-- latest one, carrying its own timestamp and its own author. A panel can then say "normal,
-- updated 14 minutes ago" — or, past the district's threshold, stop claiming "normal" at all
-- and say "not reported since 09:40".

BEGIN;

--------------------------------------------------------------------------------
-- The utilities the district watches
--------------------------------------------------------------------------------
--
-- A row per service, not a fixed list in code: Bajaur's set is Bajaur's business, and the two
-- offices change it from the console without a release (ADR-0003's reasoning, applied to a
-- much smaller thing).

CREATE TABLE IF NOT EXISTS utility (
    utility_id     uuid  PRIMARY KEY DEFAULT gen_random_uuid(),

    -- What the public calls it. This is read at four metres off a wall — "Electricity
    -- (PESCO)", not "PESCO_LT_FEEDER".
    name           text  NOT NULL,

    /**
     * Who is answerable for reporting it.
     *
     * NULL is allowed and means **nobody yet** — a service the district watches but has not
     * assigned. That is a visible, fixable gap, and it is better than either inventing an
     * owner or refusing to list the service at all (CLAUDE.md §7: build the place the data
     * goes; make the placeholder visibly a placeholder).
     */
    department_id  uuid  REFERENCES department(department_id),

    -- How long a report stays believable. Past this the panel greys and stops asserting.
    -- Per-utility because they are not alike: mains electricity changing hourly is normal,
    -- a gas outage lasting a week is one fact, not a hundred.
    stale_minutes  integer NOT NULL DEFAULT 240 CHECK (stale_minutes BETWEEN 5 AND 10080),

    position       integer NOT NULL DEFAULT 0,
    retired_at     timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),

    UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS utility_report (
    report_id    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    utility_id   uuid        NOT NULL REFERENCES utility(utility_id),

    /**
     * Three states, and the third is the point.
     *
     * `normal` and `down` are obvious. `degraded` exists because the honest answer in Bajaur is
     * usually neither — the power is on for four hours in six, the internet works but not for
     * video. A two-state model forces that into a lie in whichever direction the reporter
     * feels like rounding.
     *
     * There is deliberately no `unknown`: not reporting is how you say unknown, and the age
     * of the last report says it better than a value could (ADR-0009's reasoning — an absence
     * is not a level).
     */
    status       text        NOT NULL CHECK (status IN ('normal', 'degraded', 'down')),

    -- Free text, shown under the name. "Load shedding, 4 hrs on 2 off" says more than `degraded`.
    note         text,

    -- The seat that said so. Seats, not people, because authority attaches to the post and
    -- survives the transfer (ADR-0004).
    reported_by  uuid        REFERENCES seat(seat_id),
    reported_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS utility_report_latest
    ON utility_report (utility_id, reported_at DESC);

--------------------------------------------------------------------------------
-- The five services the district named
--------------------------------------------------------------------------------
--
-- These are **not invented**. They are the ones the owner's own prototype listed, which makes
-- them the district's answer rather than mine. What is missing is who answers for each, and
-- that gap is left visible rather than guessed: `department_id` is NULL, the console shows
-- "nobody assigned", and R-14 asks the district to say.
--
-- Seeded with no report at all, so every panel opens reading **"not reported"** rather than a
-- green tick nobody earned. A wall screen that starts out claiming the power is on, because a
-- migration said so, would be lying on the day it was installed.

INSERT INTO utility (name, position, stale_minutes) VALUES
    ('Electricity (PESCO)', 1, 240),
    ('Water supply',  2, 480),
    ('Sui Gas',             3, 720),
    ('Internet',            4, 240),
    ('PTCL / Landline',     5, 480)
ON CONFLICT (name) DO NOTHING;

--------------------------------------------------------------------------------
-- Where the officers are
--------------------------------------------------------------------------------
--
-- Against a seat, not a person, so the panel keeps reading correctly across a transfer: the
-- AAC Mamund's seat is either covered or it is not, whoever currently holds it.

CREATE TABLE IF NOT EXISTS presence_report (
    report_id    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    seat_id      uuid        NOT NULL REFERENCES seat(seat_id),

    /**
     * `office` — at their desk, reachable there
     * `field`  — out in the district, reachable by phone
     * `leave`  — not on duty at all
     *
     * `field` and `leave` are not degrees of the same thing. An officer in the field is
     * working and can be sent somewhere; an officer on leave cannot be sent anywhere. A wall
     * screen that blurred them would have somebody dispatched to Barang who is in Peshawar.
     */
    status       text        NOT NULL CHECK (status IN ('office', 'field', 'leave')),

    -- Optional and coarse on purpose. "Nawagai side" is useful; a coordinate is not permitted
    -- on a wall screen at all (ADR-0013 §1).
    note         text,

    reported_by  uuid        REFERENCES seat(seat_id),
    reported_at  timestamptz NOT NULL DEFAULT now(),

    /**
     * When this stops being believable. Set by whoever reports it, because only they know:
     * "in the field" for the next two hours is a different claim from "on leave until Monday",
     * and a single district-wide staleness rule would have to be wrong for one of them.
     *
     * NULL means "until I say otherwise", which is honest for `office` and dangerous for the
     * other two — so the API requires an end for `field` and `leave`.
     */
    until_at     timestamptz
);

CREATE INDEX IF NOT EXISTS presence_report_latest
    ON presence_report (seat_id, reported_at DESC);

--------------------------------------------------------------------------------
-- The identity a television signs in as
--------------------------------------------------------------------------------
--
-- ADR-0013 §2. The obvious build is to sign the TV in as the DC once and leave it — which is
-- the DC's account, unlocked, in a room with a door, attributing to the DC in a log whose
-- entire purpose is answering "who".
--
-- A wall screen is therefore its own kind of principal. It can read one aggregate feed and do
-- nothing else: no POST route accepts it, and it cannot reach an incident, a person or a
-- number. If the token leaks, what leaks is a screen already visible through a window.

CREATE TABLE IF NOT EXISTS wall_screen (
    screen_id     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Which room. "DC Office — main hall". The name is how a revoked screen is identified by
    -- somebody standing in front of it.
    label         text        NOT NULL,

    -- Stored hashed, exactly like a person's password. Shown once at issue and never again;
    -- a token the console could redisplay is a token in every backup in readable form.
    token_hash    text        NOT NULL,

    issued_by     uuid        REFERENCES seat(seat_id),
    issued_at     timestamptz NOT NULL DEFAULT now(),
    revoked_at    timestamptz,

    -- Set on every poll. A screen that stopped calling home is listed as such, because a dark
    -- television in the corner of an office is exactly the failure nobody reports (ADR-0005).
    last_seen_at  timestamptz,

    UNIQUE (label)
);

--------------------------------------------------------------------------------
-- Weather, cached where the server can see it
--------------------------------------------------------------------------------
--
-- One row, replaced on each successful fetch. It lives in the database rather than in memory
-- so that a restarted server still knows how old its last honest answer was, and so that a
-- district whose internet has been down since Tuesday says "Tuesday" instead of "loading".

CREATE TABLE IF NOT EXISTS weather_reading (
    reading_id    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    observed_at   timestamptz NOT NULL,
    fetched_at    timestamptz NOT NULL DEFAULT now(),
    payload       jsonb       NOT NULL
);

CREATE INDEX IF NOT EXISTS weather_reading_latest ON weather_reading (fetched_at DESC);

--------------------------------------------------------------------------------
-- Two more things the change log can be about
--------------------------------------------------------------------------------
--
-- Which services the district watches, and which televisions may read the feed, are both
-- configuration in the sense ADR-0010 uses: decisions the two offices make, that a department
-- must not be able to make quietly on its own behalf. So they are answerable for in the same
-- place as everything else.
--
-- Note what is deliberately *not* here: a `utility_report` is not a config event. It is an
-- operational fact reported many times a day, and putting it in the change log would drown
-- the log people read after an incident under a thousand rows saying the power came back on.

ALTER TABLE config_event DROP CONSTRAINT IF EXISTS config_event_subject_known;
ALTER TABLE config_event
    ADD CONSTRAINT config_event_subject_known
    CHECK (subject IN ('department', 'routing_signal', 'sla_target', 'seat', 'person', 'duty',
                       'resource', 'channel_ladder', 'utility', 'wall_screen'));

INSERT INTO schema_migration (version) VALUES ('0015_wall')
ON CONFLICT (version) DO NOTHING;

COMMIT;
