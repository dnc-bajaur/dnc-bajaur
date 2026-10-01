-- 0046 — availability is two states the control room sets by hand, and the wall's curated pick.
-- ADR-0033.
--
-- THE DISTRICT'S ASK. Mark an officer Available or Unavailable manually on the Status screen —
-- no auto-mark, no timer, no reset — then pick which available officers show on the Dashboard,
-- with name and designation.
--
-- STATUS BECOMES TWO VALUES. M9-31 made `presence_report.status` a five-answer list
-- (present · absent · office · field · leave), because a control room at 02:00 was thought to
-- want both *is this person reachable* and *where are they*. The district asked for only the
-- first: `available` / `unavailable`. The old rows fold in deterministically —
-- present/office/field are reachable, absent/leave are not — so nothing on the wall reads wrong
-- after the deploy. This is ADR-0025's answer to the utility timer applied to presence: nothing
-- polls an officer, and a duty officer typed one answer because that is the situation.
--
-- ⚠️ NO GUARD, NO `RAISE`, NO `EXCEPTION` — O-40's lesson. The value fold is deterministic and
-- there is nothing to refuse over. `presence_report` carries no append-only trigger (it is a
-- log the latest row of which is read; nothing folds it into an incident), so the `UPDATE`
-- rewrites no protected history — the same footing migration 0027 stood on to add its column.
--
-- `until_at` STAYS ON THE TABLE, inert, on ADR-0025's precedent for `stale_minutes`. `NEEDS_END`
-- is gone from the domain; a value the code no longer writes does not need its column dropped.
--
-- `seat.on_wall` IS THE CURATED PICK. A display preference the control room adjusts as shifts
-- change, not a fact about the district's structure — so it is a plain column, not a
-- `config_event`. Default false: a fresh install shows an empty wall panel, which reads as
-- *nobody on the wall*, not as broken.

BEGIN;

-- Drop the old CHECK FIRST. The fold-UPDATE below writes `available` / `unavailable`, which the
-- old `presence_report_status_known` (five location values) forbids — so the UPDATE has to
-- happen with no constraint in force, not "before the CHECK narrows". Dropped and recreated,
-- never added beside: a CHECK is not a list you append to, and two constraints on one column
-- would both have to pass (migration 0027 / 0030's lesson). 🔴 The original order (UPDATE then
-- DROP) passed `migrations.test.ts` because `freshDatabase.ts` builds an empty table — the
-- UPDATE touched zero rows. It boot-looped on Bajaur's live `presence_report` (2026-09-02).
ALTER TABLE presence_report DROP CONSTRAINT IF EXISTS presence_report_status_known;
ALTER TABLE presence_report DROP CONSTRAINT IF EXISTS presence_report_status_check;

-- Fold the five answers into two.
UPDATE presence_report
   SET status = CASE
       WHEN status IN ('present', 'office', 'field') THEN 'available'
       WHEN status IN ('absent', 'leave')            THEN 'unavailable'
       ELSE status
   END
 WHERE status IN ('present', 'office', 'field', 'absent', 'leave');

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'presence_report_status_known_v2'
    ) THEN
        ALTER TABLE presence_report
            ADD CONSTRAINT presence_report_status_known_v2
            CHECK (status IN ('available', 'unavailable'));
    END IF;
END $$;

-- The seats the control room has chosen to show on the Dashboard wall (ADR-0033).
ALTER TABLE seat ADD COLUMN IF NOT EXISTS on_wall boolean NOT NULL DEFAULT false;

INSERT INTO schema_migration (version) VALUES ('0046_officer_availability')
ON CONFLICT (version) DO NOTHING;

COMMIT;
