-- 0022 — the district composes its own dashboard (ADR-0015, M6-28).
--
-- One table and one new `config_event` subject. What it holds is **which panels the district
-- chose and how big**, per scope: one row for the two administrative offices' view of the whole
-- district, and one per department that wants its own arrangement.
--
--------------------------------------------------------------------------------
-- Why this is a table and not a fold of the log
--------------------------------------------------------------------------------
--
-- Every other setting in this system follows the same shape: a small table holding the current
-- value, plus a `config_event` row recording who changed it, from what, to what and why. This
-- is that shape, and the reasoning is the one ADR-0001 gives for settings specifically — a
-- settings table alone cannot answer *"why was this not on the screen in March?"* six weeks
-- later, and a log alone would mean folding a year of edits on every dashboard request, on the
-- machine that is also accepting emergency reports.
--
-- So: the table is the projection, `config_event` is the record, and they are written in one
-- transaction (see `recordChange`) so a crash cannot leave a layout nobody can account for.
--
--------------------------------------------------------------------------------
-- Why the layout is JSON rather than a row per panel
--------------------------------------------------------------------------------
--
-- **Order is the whole content.** A layout is a sequence — which panel is first, which is
-- fourth, which got cut — and a row-per-panel table would need a position column, which is a
-- reordering problem solved badly at every scale. A district dragging a panel up would rewrite
-- nine rows and could half-fail.
--
-- The shape is validated in `domain/panels.ts` rather than by the database, and `parseLayout`
-- refuses to trust any of it: an unknown panel id is dropped and reported, an illegible size is
-- corrected, and a value that is not a layout at all falls back to the built-in default. **A
-- screen that goes blank because a configuration row was malformed is a district that cannot
-- see its own emergencies**, which is worse than showing them a layout they did not choose.

BEGIN;

CREATE TABLE IF NOT EXISTS dashboard_layout (
    -- Null means **the district** — what the two administrative offices see. A department id
    -- means that department's own arrangement. Nullable rather than a sentinel uuid, so the
    -- foreign key still means something.
    department_id uuid        REFERENCES department(department_id),
    layout        jsonb       NOT NULL,
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- One layout per scope. A partial unique index rather than a primary key, because `NULL` is
-- never equal to itself in a unique constraint — two district layouts would be accepted, and
-- whichever one the query returned would be down to Postgres. The same shape of bug as
-- `resolveIdentity`'s missing ORDER BY, and worth closing here rather than discovering later.
CREATE UNIQUE INDEX IF NOT EXISTS dashboard_layout_district
    ON dashboard_layout ((1)) WHERE department_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS dashboard_layout_by_department
    ON dashboard_layout (department_id) WHERE department_id IS NOT NULL;

-- Answerable like every other setting: who arranged this screen, when, and what it looked like
-- before. Rows already written keep their text — the log is append-only, and a constraint that
-- rejected its own history would be a constraint that lies about what happened.
ALTER TABLE config_event DROP CONSTRAINT IF EXISTS config_event_subject_known;
ALTER TABLE config_event
    ADD CONSTRAINT config_event_subject_known
    CHECK (subject IN ('department', 'routing_signal', 'sla_target', 'seat', 'person', 'duty',
                       'resource', 'channel_ladder', 'utility', 'wall_screen',
                       'district_fact', 'district_alert', 'dashboard_layout'));

-- **No default row is inserted, deliberately.**
--
-- An empty table means "the district has not chosen", which is a different fact from "the
-- district chose the default arrangement" — and the difference shows on the editor's own
-- screen, where one reads as *nobody has looked at this yet*. `DEFAULT_LAYOUT` renders either
-- way, so nothing is lost by leaving the table empty until somebody makes a decision.

INSERT INTO schema_migration (version) VALUES ('0022_dashboard_layout')
ON CONFLICT (version) DO NOTHING;

COMMIT;
