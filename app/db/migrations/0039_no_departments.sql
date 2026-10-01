-- 0039 — the department layer is gone, and this is the migration that ends it (ADR-0030).
--
-- 0038 stopped anybody FILING into a department. This removes the thing itself: the table, the
-- column on `seat`, and every other column in the schema that pointed at it.
--
--------------------------------------------------------------------------------
-- Why this is allowed to exist at all
--------------------------------------------------------------------------------
--
-- ADR-0029 kept the department table for exactly one reason, stated plainly at the time: **past
-- incidents name their departments, and a record that cannot name what it says is a record with
-- holes in it.** Dropping the table then would have turned every `routed` and `dispatched` event
-- on the district's own history into rows nobody could read.
--
-- That reason ended on 2026-08-25, when the district said the record was test data and asked for
-- it to go. It went. So the argument for keeping the table went with it.
--
--------------------------------------------------------------------------------
-- ⚠️ THIS MIGRATION CARRIES NO GUARD, AND THE FIRST DRAFT OF IT DID
--------------------------------------------------------------------------------
--
-- That draft opened with a `DO $$ … RAISE EXCEPTION` refusing to run while `incident_event` held
-- anything. The reasoning was right and the PLACE was the mistake migration 0031 already made:
--
--   **migrations run at BOOT, so a migration that refuses does not warn anybody — it takes the
--   district off the air.** 0031's guard was correct, fired correctly, and served 502 for
--   **34 minutes across ~98 restarts**, because systemd kept restarting into the same refusal.
--
-- So the questions worth refusing over are asked by **`npm run preflight:0039`**, against the
-- live database, **before** the restart, changing nothing.
--
--------------------------------------------------------------------------------
-- 🔴 AND THE FIRST DRAFT WOULD NOT HAVE APPLIED — PROVED, NOT REVIEWED
--------------------------------------------------------------------------------
--
-- It did `DROP COLUMN department_id` and `DROP TABLE department` and nothing else. Run against a
-- real schema inside a transaction that was rolled back, it failed on its very first statement:
--
--     cannot drop column department_id of table seat because other objects depend on it
--     detail: trigger seat_tier_enforced on table seat depends on column department_id
--
-- and had that been fixed it would then have failed again, because **five tables hold a foreign
-- key into `department`** and PostgreSQL will not drop a table out from under them:
--
--     dashboard_layout.department_id · resource.department_id · seat.department_id
--     sla_target.department_id       · utility.department_id
--
-- Every one of those is a boot-time failure on the district's own server. The order below is not
-- tidiness — it is the only order that works, and each step was checked against the real schema
-- rather than against a memory of it.

BEGIN;

--------------------------------------------------------------------------------
-- 1. The trigger first, because it NAMES the column
--------------------------------------------------------------------------------
--
-- `CREATE TRIGGER … BEFORE INSERT OR UPDATE OF tier, department_id, is_administration` records a
-- dependency on each column it lists, so the column cannot be dropped while the trigger stands.
-- Replacing the FUNCTION is not enough and was what the first draft tried.
--
-- The rule it enforces narrows to what ADR-0029 §2 asked for from the beginning: authority reads
-- a COLUMN somebody ticked, never a name somebody typed.

DROP TRIGGER IF EXISTS seat_tier_enforced ON seat;

CREATE OR REPLACE FUNCTION seat_tier_from_department()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.tier := CASE WHEN NEW.is_administration THEN 'district' ELSE 'department' END;
    RETURN NEW;
END;
$$;

CREATE TRIGGER seat_tier_enforced
    BEFORE INSERT OR UPDATE OF tier, is_administration ON seat
    FOR EACH ROW EXECUTE FUNCTION seat_tier_from_department();

-- ⚠️ The FUNCTION keeps its name and `tier` keeps its two values. Renaming both is the tidier
-- change and is not this migration's job: `tier` is read by `evaluateRead`, by the escalation
-- ladder and by four API modules, and a rename touching all of them belongs in a change somebody
-- can review as one thing.

ALTER TABLE seat DROP CONSTRAINT IF EXISTS seat_department_fk;
DROP INDEX IF EXISTS seat_by_department;
ALTER TABLE seat DROP COLUMN IF EXISTS department_id;

--------------------------------------------------------------------------------
-- 2. Deadlines become the district's, and the rows that were not have to GO first
--------------------------------------------------------------------------------
--
-- `sla_target` was unique two ways: `(department_id, severity)` where a department was named, and
-- `(severity)` where it was not. Drop the column and every per-department row becomes a SECOND
-- row for a severity the district already has one for — so the district-wide unique index cannot
-- be recreated, and until it is, `setSlaTarget`'s upsert has nothing to conflict on and would
-- quietly write duplicates.
--
-- ⚠️ **The per-department rows are DELETED, and that is a real loss stated rather than hidden.**
-- A district that had given Rescue a five-minute fire deadline loses that number; the district's
-- own default applies to everybody. It is what "departments are gone" means for a deadline, and
-- `config_event` still holds every one of those settings with who set it and when.

DELETE FROM sla_target WHERE department_id IS NOT NULL;

ALTER TABLE sla_target DROP CONSTRAINT IF EXISTS sla_target_department_id_fkey;
DROP INDEX IF EXISTS sla_target_per_department;
DROP INDEX IF EXISTS sla_target_district_default;
ALTER TABLE sla_target DROP COLUMN IF EXISTS department_id;

-- One deadline per severity, for the district. The upsert in `configStore.ts` conflicts on this.
CREATE UNIQUE INDEX IF NOT EXISTS sla_target_by_severity ON sla_target (severity);

--------------------------------------------------------------------------------
-- 3. A vehicle belongs to the district now
--------------------------------------------------------------------------------
--
-- `resource.department_id` is NOT NULL and carries `(department_id, lower(name))` as its
-- uniqueness. Dropping the column drops that index with it, so the name has to carry the
-- uniqueness alone.
--
-- ⚠️ **THAT CAN COLLIDE**, and the preflight is where it is caught: two departments could each
-- have run an *Ambulance 1*, and creating this index on a district that still has both fails —
-- at boot. `preflight:0039` refuses on exactly that, before the restart.

ALTER TABLE resource DROP CONSTRAINT IF EXISTS resource_department_id_fkey;
DROP INDEX IF EXISTS resource_by_department;
DROP INDEX IF EXISTS resource_unique_live_name;
ALTER TABLE resource DROP COLUMN IF EXISTS department_id;

CREATE UNIQUE INDEX IF NOT EXISTS resource_unique_live_name
    ON resource (lower(name)) WHERE retired_at IS NULL;

--------------------------------------------------------------------------------
-- 4. A utility answers to the district, not to a department
--------------------------------------------------------------------------------
--
-- The Status screen stopped offering this control on 2026-08-23, on the owner's own reasoning:
-- *"humnai departments hata deye hain tou kis ko asign hoga"*. The column outlived the control by
-- two days. `utility_name_key` is on `name` alone and is untouched.

ALTER TABLE utility DROP CONSTRAINT IF EXISTS utility_department_id_fkey;
ALTER TABLE utility DROP COLUMN IF EXISTS department_id;

--------------------------------------------------------------------------------
-- 5. There is one wall, so there is one layout
--------------------------------------------------------------------------------
--
-- Both of this table's indexes name the column — `((1)) WHERE department_id IS NULL` for the
-- district's, and `(department_id) WHERE department_id IS NOT NULL` for a department's. With no
-- departments there is one row, and the constant-expression index is what enforces that.
--
-- ⚠️ **Any per-department layout is DELETED.** ADR-0015 says the layout is the district's to
-- compose, and a department's own arrangement of a screen no department can open is a row that
-- can only ever be restored onto a wall nobody reads.

DELETE FROM dashboard_layout WHERE department_id IS NOT NULL;

ALTER TABLE dashboard_layout DROP CONSTRAINT IF EXISTS dashboard_layout_department_id_fkey;
DROP INDEX IF EXISTS dashboard_layout_by_department;
DROP INDEX IF EXISTS dashboard_layout_district;
ALTER TABLE dashboard_layout DROP COLUMN IF EXISTS department_id;

CREATE UNIQUE INDEX IF NOT EXISTS dashboard_layout_district ON dashboard_layout ((1));

--------------------------------------------------------------------------------
-- 6. And now, with nothing pointing at it, the table
--------------------------------------------------------------------------------

DROP TABLE IF EXISTS department;

--------------------------------------------------------------------------------
-- 7. `config_event.subject` IS DELIBERATELY LEFT ALONE
--------------------------------------------------------------------------------
--
-- The obvious tidy-up is to drop 'department' from the allowed subjects. The first draft did, and
-- it was wrong twice.
--
-- 🔴 IT NAMED THE WRONG CONSTRAINT. Migration 0007 created `config_event_subject_check`; 0009
-- replaced it with `config_event_subject_known` and nine migrations have widened that one since.
-- `DROP CONSTRAINT IF EXISTS` against a name that no longer exists succeeds SILENTLY, so the new
-- CHECK would have been added BESIDE the real one — and two CHECKs on a column both have to
-- pass. That is the trap migration 0027 already paid for on `presence_report.status`.
--
-- 🔴 AND IT WOULD NOT HAVE APPLIED. `ADD CONSTRAINT` validates the rows already there. The config
-- log holds `department` rows — every department ever created, retired or edited — and it is
-- append-only under a trigger, so they cannot be removed and must not be.
--
-- The log keeps its vocabulary. It records what was configured on the day it was configured, and
-- every one of those sentences is still true. What stops is anything WRITING a new one, and there
-- is nothing left that can.

INSERT INTO schema_migration (version) VALUES ('0039_no_departments')
ON CONFLICT (version) DO NOTHING;

COMMIT;
