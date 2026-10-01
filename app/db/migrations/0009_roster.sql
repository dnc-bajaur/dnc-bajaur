-- 0009 — the roster: who holds which post, edited by the people who know.
--
-- Until now the only way a contact entered this system was a JSON file loaded by hand. That
-- makes every correction in a district of ~80 offices route through whoever has the file,
-- which is exactly the dependency the administration console exists to remove — and it is
-- why Rescue 1122's missing number sat unfixed long enough to become a milestone blocker.
--
-- **Two audiences, one model.** The DC and AC Headquarter offices maintain every
-- department's roster; a department maintains its own. Same tables, same operations, scoped
-- by the caller's department. Owner, 2026-08-02:
--
--   > department ki data sai mera matlab ye hai wo apne dashboard pr data edit kr ske, yaane
--   > k kese ko add kar ske, remove kar ske, data daik ske... ye mera matlab nhe hai k ju
--   > signals 2 offices assign karenge us edit kr skenge.
--
-- So: a department edits **its own people and posts**. Routing signals and SLA deadlines
-- stay with the two offices (ADR-0010), because a department able to edit its own routing
-- could quietly stop receiving night-time calls and nothing would show it.

BEGIN;

--------------------------------------------------------------------------------
-- The configuration log learns three more subjects
--------------------------------------------------------------------------------
--
-- Roster changes are configuration changes, and they are the ones most likely to be asked
-- about afterwards: *who removed the duty officer from that post the week nobody answered?*
-- Migration 0007 restricted `subject` to three values; these are the rest.
ALTER TABLE config_event DROP CONSTRAINT IF EXISTS config_event_subject_known;
ALTER TABLE config_event
    ADD CONSTRAINT config_event_subject_known
    CHECK (subject IN ('department', 'routing_signal', 'sla_target', 'seat', 'person', 'duty'));

-- Relieving somebody, retiring a post and disabling an account all stop notifications
-- reaching a human. None of them should be possible anonymously and without a reason — the
-- same rule 0007 applied to retiring a department, and the same rule INV-06 applies to
-- destructive incident events.
ALTER TABLE config_event DROP CONSTRAINT IF EXISTS config_event_retire_needs_reason;
ALTER TABLE config_event
    ADD CONSTRAINT config_event_retire_needs_reason
    CHECK (action <> 'retired' OR (reason IS NOT NULL AND btrim(reason) <> ''));

--------------------------------------------------------------------------------
-- Posts can be retired
--------------------------------------------------------------------------------
--
-- Never deleted. Past events name the seat that acted, and `evaluateRead` resolves authority
-- through it; a deleted post would make its own history unreadable (ADR-0001, ADR-0004).
--
-- A retired post holds nobody and receives nothing. That is deliberately the *same* state
-- the escalation ladder already handles as "vacant" rather than a new one to special-case.
ALTER TABLE seat ADD COLUMN IF NOT EXISTS retired_at timestamptz;

CREATE INDEX IF NOT EXISTS seat_live_by_department
    ON seat (department_id) WHERE retired_at IS NULL;

--------------------------------------------------------------------------------
-- People can be added by the district, and removed without being erased
--------------------------------------------------------------------------------

-- Who created this record, so a roster entry nobody recognises can be traced. Null for the
-- ~80 rows loaded from the district's own contact list before this existed.
ALTER TABLE person ADD COLUMN IF NOT EXISTS created_by_seat_id uuid REFERENCES seat(seat_id);

-- Removing a person from the roster does not remove them from the record.
--
-- `disabled_at` already stops an account signing in (migration 0003). This is the directory
-- half of the same idea: a contact who has left the district stops being offered as somebody
-- to notify, and every event they are named in still resolves to a name.
ALTER TABLE person ADD COLUMN IF NOT EXISTS removed_at timestamptz;

CREATE INDEX IF NOT EXISTS person_live ON person (person_id) WHERE removed_at IS NULL;

INSERT INTO schema_migration (version) VALUES ('0009_roster')
ON CONFLICT (version) DO NOTHING;

COMMIT;
