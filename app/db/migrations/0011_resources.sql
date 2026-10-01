-- 0011 — what a department has to send: vehicles, teams, equipment (M1-02).
--
-- The `assigned` event has existed since migration 0001 and nothing has ever produced one,
-- because there was nothing to assign. A department could acknowledge an emergency and log
-- what it did, and the step in between — **sending something** — had no representation at
-- all. That is the gap this closes.
--
--------------------------------------------------------------------------------
-- One table, three kinds
--------------------------------------------------------------------------------
--
-- A vehicle, a crew and a piece of equipment are different things in the world and the same
-- thing to dispatch: a unit a department commits to an incident. Modelling them separately
-- would mean three tables, three screens and three ways to answer "what is Rescue 1122
-- currently able to send", which is the question that matters at 02:00.
--
-- The one real difference is that a **team has people in it**, so teams get a membership
-- table and the other kinds simply never use it.
--
--------------------------------------------------------------------------------
-- Availability is derived, not stored — mostly
--------------------------------------------------------------------------------
--
-- There is no `status` column, and that is deliberate (ADR-0001, and the same reasoning as
-- "there is no board table"). Whether an ambulance is committed right now is a **fact about
-- the event log**: it was assigned to an incident that is not yet closed. A status column
-- would be a second copy of that, free to drift, and the way it drifts is an ambulance that
-- the screen says is free and the log says is at a road accident.
--
-- What *is* stored is the one thing the log cannot know: **out of service**. A vehicle in
-- the workshop is not a fact about any incident, so somebody has to say so, with a reason
-- and a name against it.

BEGIN;

CREATE TABLE IF NOT EXISTS resource (
    resource_id   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    department_id uuid        NOT NULL REFERENCES department(department_id),

    kind          text        NOT NULL CHECK (kind IN ('vehicle', 'team', 'equipment')),

    -- What the department calls it. "Ambulance 3", "Rescue Team B", "Hydraulic cutter".
    name          text        NOT NULL CHECK (btrim(name) <> ''),

    -- The registration, call sign or asset number, if it has one. Shown next to the name so
    -- an operator on the radio can say the thing the other end will recognise.
    identifier    text,

    -- The one fact the event log cannot derive. Both columns move together — a unit taken
    -- off the run without a stated reason is a unit nobody can put back with confidence.
    out_of_service_at     timestamptz,
    out_of_service_reason text,

    retired_at    timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT resource_out_of_service_needs_reason
        CHECK (out_of_service_at IS NULL
               OR (out_of_service_reason IS NOT NULL AND btrim(out_of_service_reason) <> ''))
);

-- Two live units with the same name in one department make a radio call ambiguous, which is
-- the exact failure this name exists to prevent.
CREATE UNIQUE INDEX IF NOT EXISTS resource_unique_live_name
    ON resource (department_id, lower(name))
    WHERE retired_at IS NULL;

CREATE INDEX IF NOT EXISTS resource_by_department
    ON resource (department_id) WHERE retired_at IS NULL;

--------------------------------------------------------------------------------
-- Who is on a team
--------------------------------------------------------------------------------
--
-- Membership has dates for the same reason duty assignments do (ADR-0004): "who was on
-- Rescue Team B that night" must stay answerable after the roster changes. Leaving a team is
-- an end date, never a delete.
CREATE TABLE IF NOT EXISTS resource_member (
    membership_id uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    resource_id   uuid        NOT NULL REFERENCES resource(resource_id),
    person_id     uuid        NOT NULL REFERENCES person(person_id),
    from_at       timestamptz NOT NULL DEFAULT now(),
    to_at         timestamptz,

    CONSTRAINT resource_member_range_sane CHECK (to_at IS NULL OR to_at > from_at)
);

-- One person cannot be on the same team twice at once. They may be on two different teams,
-- which is real — a driver who is also a first aider — and is a staffing decision the
-- district gets to make rather than one this schema should refuse.
CREATE UNIQUE INDEX IF NOT EXISTS resource_member_one_current
    ON resource_member (resource_id, person_id)
    WHERE to_at IS NULL;

CREATE INDEX IF NOT EXISTS resource_member_by_person
    ON resource_member (person_id) WHERE to_at IS NULL;

--------------------------------------------------------------------------------
-- The configuration log learns one more subject
--------------------------------------------------------------------------------
--
-- Taking a unit out of service stops it being dispatched. *Who took the second ambulance off
-- the run the week we could not answer a call?* is exactly the question `config_event` is
-- for, and the reason requirement already applies to anything retired.
ALTER TABLE config_event DROP CONSTRAINT IF EXISTS config_event_subject_known;
ALTER TABLE config_event
    ADD CONSTRAINT config_event_subject_known
    CHECK (subject IN ('department', 'routing_signal', 'sla_target', 'seat', 'person', 'duty',
                       'resource'));

INSERT INTO schema_migration (version) VALUES ('0011_resources')
ON CONFLICT (version) DO NOTHING;

COMMIT;
