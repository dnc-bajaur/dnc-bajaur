-- 0007 — the administration console: routing signals, SLA targets, and a config history.
--
-- ADR-0010 made the DC Office and the AC Headquarter Bajaur Office the authority for the
-- whole district, with every other department reporting to them. That turns three things
-- which were previously code, guesses, or open questions into **data those two offices
-- edit**:
--
--   * which department answers for which kind of emergency  (was: nothing at all)
--   * how long a department has to acknowledge               (was: PLACEHOLDER_SLA in code)
--   * whether a department exists                            (was: a seed file)
--
-- The third one already had a table (0005). This migration adds the first two, and adds the
-- thing all three need and none of them had: **a record of who changed the configuration,
-- when, and why.**

BEGIN;

--------------------------------------------------------------------------------
-- Configuration history — the same argument as ADR-0001, applied to settings
--------------------------------------------------------------------------------
--
-- `incident_event` is append-only because the district's record of what happened must not
-- be quietly rewritten. Configuration deserves the same treatment for a reason that only
-- becomes obvious after an incident review:
--
--   "Why was this not flagged late?"  — because on that night the target was 60 minutes.
--   "Why did this go to the wrong department?" — because that signal was added on Tuesday.
--
-- A settings table that only holds the current value cannot answer either question. It
-- makes every past judgement of the system unexplainable, and it makes the two offices'
-- own decisions unattributable. So configuration changes are events too, in their own log,
-- with the same append-only guarantee.
--
-- Separate from `incident_event` on purpose: these are not facts about an incident, they
-- have no incident id, and folding them into the incident log would mean every projection
-- and every replay had to skip rows that are not about incidents at all.
CREATE TABLE IF NOT EXISTS config_event (
    event_id      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    seq           bigserial   NOT NULL UNIQUE,

    -- What was configured: 'department', 'routing_signal', 'sla_target'.
    subject       text        NOT NULL,
    -- The row it concerns. Not a foreign key: the log must survive the subject being
    -- deleted, and outliving its subject is the entire point of a record.
    subject_id    uuid        NOT NULL,
    -- 'created', 'updated', 'retired', 'restored'.
    action        text        NOT NULL,

    -- Enough to reconstruct the change, not a diff engine. Whole before/after values.
    before        jsonb,
    after         jsonb,

    -- Who. A seat, because authority attaches to the post (ADR-0004).
    actor_seat_id   uuid      REFERENCES seat(seat_id),
    actor_person_id uuid      REFERENCES person(person_id),

    -- Free text, and required for anything destructive. See the CHECK below.
    reason        text,

    recorded_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT config_event_subject_known
        CHECK (subject IN ('department', 'routing_signal', 'sla_target')),
    CONSTRAINT config_event_action_known
        CHECK (action IN ('created', 'updated', 'retired', 'restored')),

    -- Retiring a department stops emergencies reaching it. That is not a change anyone
    -- should be able to make anonymously and without saying why (INV-06 applies the same
    -- rule to destructive incident events).
    CONSTRAINT config_event_retire_needs_reason
        CHECK (action <> 'retired' OR (reason IS NOT NULL AND btrim(reason) <> ''))
);

CREATE INDEX IF NOT EXISTS config_event_by_subject
    ON config_event (subject, subject_id, seq);
CREATE INDEX IF NOT EXISTS config_event_by_time
    ON config_event (recorded_at DESC);

CREATE OR REPLACE FUNCTION config_event_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION
        'config_event is append-only; % is not permitted. Correct a mistake by appending a new event.',
        TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS config_event_no_update ON config_event;
CREATE TRIGGER config_event_no_update
    BEFORE UPDATE OR DELETE ON config_event
    FOR EACH ROW
    EXECUTE FUNCTION config_event_reject_mutation();

DROP TRIGGER IF EXISTS config_event_no_truncate ON config_event;
CREATE TRIGGER config_event_no_truncate
    BEFORE TRUNCATE ON config_event
    FOR EACH STATEMENT
    EXECUTE FUNCTION config_event_reject_mutation();

--------------------------------------------------------------------------------
-- Routing signals — which department answers for which kind of emergency
--------------------------------------------------------------------------------
--
-- ADR-0010: "Routing is configuration, not inference." A signal is a match rule the
-- administration writes against a department. Two kinds, deliberately only two:
--
--   category — the incident's category equals this, exactly, after normalisation.
--              Precise. What you use once categories settle down.
--   keyword  — this word appears in the category or the description text.
--              Forgiving. What you use on day one, when reports are free text in a hurry.
--
-- No regular expressions and no boolean expressions. A routing rule that needs debugging
-- is a routing rule that will send a fire to the wrong department at 02:00, and the person
-- editing it is an administrator under pressure, not a programmer (ADR-0007).
CREATE TABLE IF NOT EXISTS routing_signal (
    signal_id     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    department_id uuid        NOT NULL REFERENCES department(department_id),

    kind          text        NOT NULL CHECK (kind IN ('category', 'keyword')),

    -- Stored already normalised — lowercased and trimmed — so matching never depends on
    -- how carefully someone typed it into a form.
    pattern       text        NOT NULL CHECK (btrim(pattern) <> ''),

    created_at    timestamptz NOT NULL DEFAULT now(),
    -- Retired rather than deleted, so `config_event` history keeps pointing at something.
    retired_at    timestamptz
);

-- The same signal twice for one department is a mistake, not a preference. Uniqueness
-- applies only to live rows: retiring "fire" and later adding it back must work.
CREATE UNIQUE INDEX IF NOT EXISTS routing_signal_unique_live
    ON routing_signal (department_id, kind, pattern)
    WHERE retired_at IS NULL;

-- The read path: given a category and some text, which departments claim it? Every lookup
-- filters to live rows first.
CREATE INDEX IF NOT EXISTS routing_signal_live
    ON routing_signal (kind, pattern)
    WHERE retired_at IS NULL;

--------------------------------------------------------------------------------
-- SLA targets — the deadline, as data (Q-06)
--------------------------------------------------------------------------------
--
-- `PLACEHOLDER_SLA` has been rendering "past deadline" to operators as though it were the
-- district's own rule. It was a guess in a source file. The owner's answer to Q-06 was that
-- the DC and AC Headquarter offices set these themselves, which makes the guess a default
-- value rather than a fact.
--
-- `department_id IS NULL` means the district-wide default, used when a department has not
-- set its own. Rescue 1122 should not inherit the Education department's deadline.
CREATE TABLE IF NOT EXISTS sla_target (
    target_id     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    department_id uuid        REFERENCES department(department_id),

    severity      text        NOT NULL
                  CHECK (severity IN ('critical', 'high', 'moderate', 'low', 'unknown')),

    -- Minutes to acknowledge. Bounded on both ends: zero would mean every incident is
    -- overdue the instant it arrives, and a week is not a deadline anyone is measured by.
    ack_minutes   integer     NOT NULL CHECK (ack_minutes > 0 AND ack_minutes <= 10080),

    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- One target per department per severity, and one district default per severity. Postgres
-- treats NULLs as distinct in a unique index, so the default row needs its own.
CREATE UNIQUE INDEX IF NOT EXISTS sla_target_per_department
    ON sla_target (department_id, severity)
    WHERE department_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sla_target_district_default
    ON sla_target (severity)
    WHERE department_id IS NULL;

-- Seed the district defaults from what the code has been using, so nothing changes
-- behaviour on the day this migration runs. These are now **editable values with a
-- history**, which is the whole difference, rather than new numbers.
--
-- `unknown` matches `high` deliberately: an unassessed report is not a low priority, it is
-- an unanswered question, and ADR-0009 puts that urgency in the deadline rather than
-- inventing a severity nobody assessed.
INSERT INTO sla_target (department_id, severity, ack_minutes)
VALUES (NULL, 'critical', 5),
       (NULL, 'high',     15),
       (NULL, 'moderate', 60),
       (NULL, 'low',      240),
       (NULL, 'unknown',  15)
ON CONFLICT DO NOTHING;

--------------------------------------------------------------------------------
-- Departments gain the fields an administrator actually edits
--------------------------------------------------------------------------------

-- A department-level number for the office itself, distinct from any individual's mobile.
-- Nullable, and expected to be null for a long time: most of the district's list gives a
-- person's number, not an office line.
ALTER TABLE department ADD COLUMN IF NOT EXISTS contact_phone text;

-- What this department is for, in the administration's own words. Shown next to the
-- routing signals, because "which department handles a canal breach?" is answered by a
-- sentence far more often than by a name.
ALTER TABLE department ADD COLUMN IF NOT EXISTS description text;

ALTER TABLE department ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

--------------------------------------------------------------------------------
-- Who is the administration
--------------------------------------------------------------------------------
--
-- ADR-0010: two offices are the authority for the whole district, and there is no third
-- rung. Everything above needs to know which two.
--
-- **On the department, not the seat.** The owner said *offices*, and an office is what
-- survives a transfer (ADR-0004). The DC Office holds several posts — the DC, the ADCs, the
-- PS — and they are all part of the administration. Marking one seat would mean the console
-- goes dark whenever that particular chair is empty.
--
-- **Not settable through the admin API, deliberately.** These two offices can create and
-- retire departments, so if they could also grant this flag they could mint a third
-- administration, which is exactly what ADR-0010 forbids. Changing it is a deliberate act at
-- the database by whoever holds the server, and it should require the conversation that
-- implies. There is no screen for it and that is the feature.
ALTER TABLE department
    ADD COLUMN IF NOT EXISTS is_administration boolean NOT NULL DEFAULT false;

-- Bajaur's two, by the codes the district's own contact list produced. A fresh deployment
-- elsewhere matches nothing here and must mark its own — see docs/08-runbook.md.
UPDATE department
   SET is_administration = true
 WHERE code IN ('deputy-commissioner-office', 'assistant-commissioner-bajaur');

CREATE INDEX IF NOT EXISTS department_administration
    ON department (department_id) WHERE is_administration;

INSERT INTO schema_migration (version) VALUES ('0007_administration')
ON CONFLICT (version) DO NOTHING;

COMMIT;
