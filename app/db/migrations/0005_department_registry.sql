-- 0005 — the department registry (M0-51).
--
-- Until now `seat.department_id` was a bare uuid referencing nothing. Departments were
-- therefore not a thing the system knew about — they were an id that happened to be equal
-- to another id, and every screen rendered them as raw uuids to operators.
--
-- Two consequences this fixes, in order of who notices:
--
--   * an operator sees "Rescue 1122" instead of 8f3c1a2e-…
--   * M2's gate ("adding a fifth department is a configuration exercise measured in hours")
--     becomes possible at all. You cannot configure a table that does not exist.

BEGIN;

CREATE TABLE IF NOT EXISTS department (
    department_id uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- A stable slug the code and the seed file can both name. Ids are generated, names get
    -- corrected; this is the thing that survives both.
    code          text        NOT NULL UNIQUE,

    -- Exactly as the district writes it. Not normalised, not abbreviated, not translated.
    name          text        NOT NULL,

    -- Set to retire a department without deleting it: its incidents must stay readable, and
    -- the events naming it must keep meaning what they meant.
    retired_at    timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- Backfill before constraining.
--
-- Every `seat.department_id` written before this migration points at nothing — that is the
-- bug being fixed. Adding the foreign key against such a table fails outright, so the
-- orphans get a home first.
--
-- They are named for what they are rather than quietly deleted or nulled. An id that was
-- never a department is a real gap in the registry, and a row reading "Unregistered
-- department (a1b2…)" on a board is a prompt to go and fix it. Nulling them would erase the
-- evidence that anything was wrong, which is the opposite of what this project does with
-- gaps (ADR-0005).
--
-- On a fresh district deployment this inserts nothing.
INSERT INTO department (code, name)
SELECT DISTINCT
       'unregistered-' || s.department_id::text,
       'Unregistered department (' || left(s.department_id::text, 8) || ')'
  FROM seat s
 WHERE s.department_id IS NOT NULL
   AND NOT EXISTS (
         SELECT 1 FROM department d WHERE d.department_id = s.department_id
       )
ON CONFLICT (code) DO NOTHING;

-- Point the backfilled rows at the departments just created for them.
UPDATE seat s
   SET department_id = d.department_id
  FROM department d
 WHERE d.code = 'unregistered-' || s.department_id::text;

-- Seats now point at a real department.
--
-- Nullable on purpose: the district control room and the DC hold department-agnostic seats,
-- and `nextSeatUp` in the escalation ladder depends on that (a seat with `department_id IS
-- NULL` is how "escalate out of the department" is expressed).
ALTER TABLE seat
    DROP CONSTRAINT IF EXISTS seat_department_fk;
ALTER TABLE seat
    ADD CONSTRAINT seat_department_fk
    FOREIGN KEY (department_id) REFERENCES department(department_id);

CREATE INDEX IF NOT EXISTS seat_by_department ON seat (department_id);

-- A person in the directory is not necessarily an account.
--
-- The contact list is ~80 named officials the system must be able to *notify*. That is a
-- different thing from ~80 people who can *sign in*. Creating a credential for someone who
-- has never been told the system exists is a liability, not a convenience: it is an account
-- nobody is watching, with a password nobody chose.
--
-- NULL password_hash therefore means **directory entry, cannot authenticate**. `login()`
-- already fails closed on it (the hash comparison runs against a dummy and cannot match),
-- and there is now a test pinning that rather than leaving it to luck.
ALTER TABLE person
    ALTER COLUMN password_hash DROP NOT NULL;

INSERT INTO schema_migration (version) VALUES ('0005_department_registry')
ON CONFLICT (version) DO NOTHING;

COMMIT;
