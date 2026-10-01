-- 0017 — the rest of the district's condition board (M4).
--
-- Three additions, all so the dashboard can answer what the owner's prototype answers.
--
--------------------------------------------------------------------------------
-- 1. One mechanism, not four
--------------------------------------------------------------------------------
--
-- The prototype has "Market Status", "Schools Status", "Hospital Status" and "Road Closures"
-- as four separate things beside its five utilities. They are not four things. Every one of
-- them has exactly the shape `utility` already has: **a name, a state, a note, and an age.**
--
-- So rather than four new tables, four new endpoints and four new console screens, `utility`
-- gains a `panel` column and the district gets rows. Bijli and bazaar are the same kind of
-- fact reported the same way, and the district can add a fifth kind next year without a
-- release — the same argument ADR-0003 makes about authority rules and ADR-0010 about routing.
--
-- The name `utility` is now slightly narrow for what the table holds. Renaming it would touch
-- the store, the API, the console and two test files to buy nothing a comment cannot; the
-- comment is here instead.

BEGIN;

ALTER TABLE utility ADD COLUMN IF NOT EXISTS panel text NOT NULL DEFAULT 'utility';

ALTER TABLE utility DROP CONSTRAINT IF EXISTS utility_panel_known;
ALTER TABLE utility
    ADD CONSTRAINT utility_panel_known CHECK (panel IN ('utility', 'services'));

-- The four the prototype named. Seeded with **no report**, exactly like the utilities were:
-- a board that opens claiming the markets are open, because a migration said so, is lying on
-- the day it is installed.
INSERT INTO utility (name, panel, position, stale_minutes) VALUES
    ('Markets',        'services', 1, 720),
    ('Schools',        'services', 2, 720),
    ('DHQ Hospital',   'services', 3, 480),
    ('Roads',          'services', 4, 480)
ON CONFLICT (name) DO NOTHING;

--------------------------------------------------------------------------------
-- 2. The facts about Bajaur that do not change on a Tuesday
--------------------------------------------------------------------------------
--
-- Tehsils, union councils, population, area. These are not *reports* — nobody watches them,
-- they have no age worth showing, and treating them like the panels above would put "updated
-- 4 months ago" beside a number that is supposed to be four months old.
--
-- They are also **not constants in code**. A census happens; a tehsil is created. The two
-- offices set these from the console, and every change lands in the config log like any other.
--
-- Deliberately free text rather than numbers: "1,167,892" and "1,227 km²" are how a district
-- writes them, and parsing that into an integer to render it back with separators is work
-- that buys a validation error nobody wanted.

CREATE TABLE IF NOT EXISTS district_fact (
    key         text        PRIMARY KEY,
    label       text        NOT NULL,
    value       text,
    position    integer     NOT NULL DEFAULT 0,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    updated_by  uuid        REFERENCES seat(seat_id)
);

-- Seeded with the labels and **no values**. The place exists; what goes in it is the
-- district's to supply (CLAUDE.md §7 — build the place the data goes, and make a placeholder
-- visibly a placeholder). R-15 asks for these.
INSERT INTO district_fact (key, label, position) VALUES
    ('tehsils',        'Tehsils',        1),
    ('union_councils', 'Union councils', 2),
    ('population',     'Population',     3),
    ('area',           'Area',           4)
ON CONFLICT (key) DO NOTHING;

--------------------------------------------------------------------------------
-- 3. Alerts and advisories
--------------------------------------------------------------------------------
--
-- VIP movement, a security advisory, a road closure, a weather warning. The district's own
-- announcements — not emergencies, and deliberately not stored as them: an emergency has a
-- responsible department, an acknowledgement deadline and an escalation ladder, and none of
-- those mean anything for "Khar Road is closed for maintenance".
--
-- **Issued by the two offices only**, at the owner's instruction (2026-08-03). A district-wide
-- advisory is an administrative announcement; every department reads it. The alternative —
-- any department posting to the board every office reads — is a board nobody can trust, and
-- the district plans around what is on it.

CREATE TABLE IF NOT EXISTS district_alert (
    alert_id    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

    /**
     * The short word on the pill: VIP, SECURITY, ROAD, WEATHER, OTHER.
     *
     * A fixed list rather than free text. On a screen read from across a room these are
     * recognised by shape before they are read, and a district that could type anything would
     * have "Security", "SECURITY" and "Sec. Advisory" sitting in one column within a month.
     */
    tag         text        NOT NULL CHECK (tag IN ('vip', 'security', 'road', 'weather', 'other')),

    -- What is being announced. Short: it is read at a glance, not studied.
    message     text        NOT NULL CHECK (length(message) BETWEEN 3 AND 200),

    issued_by   uuid        REFERENCES seat(seat_id),
    issued_at   timestamptz NOT NULL DEFAULT now(),

    /**
     * When it stops mattering. Required.
     *
     * An advisory with no end is the whole problem with advisory boards: the road reopens,
     * the VIP leaves, and the notice stays up for eleven months until it is furniture. Making
     * the district state an end means the board empties itself.
     */
    until_at    timestamptz NOT NULL,

    -- Withdrawn early — the closure was lifted, the movement cancelled. Kept, not deleted:
    -- "we told the district the road was shut" is a thing somebody may have to answer for.
    withdrawn_at timestamptz,
    withdrawn_reason text
);

CREATE INDEX IF NOT EXISTS district_alert_live
    ON district_alert (until_at DESC) WHERE withdrawn_at IS NULL;

ALTER TABLE config_event DROP CONSTRAINT IF EXISTS config_event_subject_known;
ALTER TABLE config_event
    ADD CONSTRAINT config_event_subject_known
    CHECK (subject IN ('department', 'routing_signal', 'sla_target', 'seat', 'person', 'duty',
                       'resource', 'channel_ladder', 'utility', 'wall_screen',
                       'district_fact', 'district_alert'));

INSERT INTO schema_migration (version) VALUES ('0017_district_board')
ON CONFLICT (version) DO NOTHING;

COMMIT;
