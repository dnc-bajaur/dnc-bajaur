-- 0023 — the control room is the product; everything else is hidden, not deleted (ADR-0016, M6-42).
--
-- One row, holding which screens this installation offers.
--
--------------------------------------------------------------------------------
-- Why a table for what looks like a constant
--------------------------------------------------------------------------------
--
-- Because it is a **district's decision**, not a build's. Bajaur wants the control room and
-- nothing else this month; the district next door may want department workspaces on day one;
-- Bajaur itself will want the field intake the week somebody first drives to a scene. Baking it
-- into a release means a release every time somebody changes their mind, on a system installed
-- by a district with no developer.
--
-- Same shape as every other setting here: a small table for the current value, plus a
-- `config_event` row recording who changed it, from what, to what and why. The log answers
-- *"why could nobody find the search screen in March?"* — which a settings table alone cannot,
-- and which is exactly the question a hidden screen generates.
--
--------------------------------------------------------------------------------
-- What this is NOT
--------------------------------------------------------------------------------
--
-- **Not an authority model.** A capability decides whether a screen is *offered*; it decides
-- nothing about what a caller may *do*. Every endpoint behind every one of these still asks the
-- policy table (INV-05), and turning a capability off secures nothing. Two mechanisms, and
-- conflating them would mean an administrator believing they had revoked access by tidying a
-- menu.
--
-- **Nothing is deleted.** Migration 0018 is the precedent and it is recent enough to still
-- sting: the provider ladder was dropped for excellent reasons on 3 August, and ADR-0014 rebuilt
-- a version of it forty-eight hours later. The offline substrate is the sharp case — removing
-- the outbox would not make `spine.e2e.test.ts` fail, it would make INV-01's proof *disappear*,
-- and the suite would go green having stopped measuring the one claim this project exists to
-- make. M6-45 keeps every hidden screen in `npm run check` and in CI for that reason.

BEGIN;

CREATE TABLE IF NOT EXISTS capability_state (
    -- One row, always. A boolean primary key fixed to true is the smallest way to say that in
    -- SQL, and it means a second row is a constraint violation rather than a silent second
    -- answer that whichever query ran first would win.
    only_row boolean     PRIMARY KEY DEFAULT true CHECK (only_row),
    state    jsonb       NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- `subject_id` is a uuid, and a capability's identity is its **name** — `search`, `fleet`.
--
-- Every other subject here is a row with a generated id, so a uuid column was right for eleven
-- years' worth of settings and is wrong for this one. The choices were: mint a synthetic uuid
-- per capability, which makes the history screen unreadable to answer nothing; or widen the
-- column to text, which every existing row already satisfies.
--
-- Widened. A uuid *is* text, the index keeps working, and the history screen can now say
-- "the search screen was turned on" rather than showing an id somebody has to look up. The
-- append-only log keeps every row it already had, unchanged — this changes how the column is
-- typed, never what is in it.
ALTER TABLE config_event ALTER COLUMN subject_id TYPE text;

ALTER TABLE config_event DROP CONSTRAINT IF EXISTS config_event_subject_known;
ALTER TABLE config_event
    ADD CONSTRAINT config_event_subject_known
    CHECK (subject IN ('department', 'routing_signal', 'sla_target', 'seat', 'person', 'duty',
                       'resource', 'channel_ladder', 'utility', 'wall_screen',
                       'district_fact', 'district_alert', 'dashboard_layout', 'capability'));

-- **No row is inserted.** An empty table means "nobody has chosen", which is a different fact
-- from "somebody chose the defaults" — and the console says so, because only the first one is
-- an invitation. `defaultCapabilities()` resolves either way, so nothing is lost by waiting for
-- a decision. Same reasoning as the dashboard layout in 0022.

INSERT INTO schema_migration (version) VALUES ('0023_capabilities')
ON CONFLICT (version) DO NOTHING;

COMMIT;
