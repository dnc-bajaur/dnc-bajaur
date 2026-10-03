-- 0038 — the department layer stops being somewhere a contact is filed (ADR-0029).
--
-- The district answered all three questions in `backlog/contacts-without-departments.md` §10 and
-- added the one they had wanted from the start:
--
--   > "Mujhe simple phone ki tarha contact add karne ka option chahiye — Name, phone,
--   >  post/designation … agar iske liye departments ko completely wash karna pare to bhi kar do."
--
-- ADR-0023 took departments off the **picker** on 2026-08-22 and left the **table** standing, which
-- is why they had to ask twice. This migration moves the one thing that was load-bearing and
-- retires what the district asked to be rid of.
--
--------------------------------------------------------------------------------
-- ⚠️ THIS MIGRATION CANNOT REFUSE, AND THAT IS DELIBERATE — O-40
--------------------------------------------------------------------------------
--
-- Migration 0031 held a guard that refused to run when the district's data contradicted it. The
-- guard was correct and it fired correctly, and because migrations run at boot, the refusal took
-- Bajaur off the air from 19:08 to 19:42 UTC — about 98 systemd restarts, 502 the whole way. O-40
-- is still open: **until the preflight exists, a migration that can refuse is a migration that can
-- take the district off the air.**
--
-- So there is no `RAISE EXCEPTION` below. It is not needed, and the reason is worth stating rather
-- than assumed: `seat.is_administration` is backfilled to **exactly** the value `sessions.ts`
-- computes today by joining to `department`. The backfill cannot lose information, cannot disagree
-- with the old path, and cannot produce a state that the join would not have produced a second
-- earlier. There is nothing here for a guard to catch.
--
-- The thing that WOULD be worth catching — *"no contact is the administration, so nobody can issue
-- an advisory"* — is reported by `scripts/preflight-0038.mjs`, which runs against the database
-- BEFORE the restart and changes nothing.

BEGIN;

--------------------------------------------------------------------------------
-- 1. `is_administration` moves from the department onto the contact
--------------------------------------------------------------------------------
--
-- ADR-0029 §2. This is the whole of what survives the removal, and it survives as a checkbox
-- rather than as a table because **permission must never be read out of typed words.** The
-- district's rule — "agar AC HQ likha hai to pata chal gaya ke administration hai" — is perfect
-- for a human reading the screen and unusable as an authorisation rule: a typo, a rename, or an
-- officer entered as "AC HQ (acting)" would silently gain or lose the right to issue an advisory,
-- and nothing on any screen would show that it had happened.

ALTER TABLE seat ADD COLUMN IF NOT EXISTS is_administration boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN seat.is_administration IS
    'ADR-0029: this contact is the DC Office or the AC Headquarter. Ticked by the two offices, never inferred from the designation.';

-- Backfill from the department the seat is filed under — the same expression `sessions.ts` has
-- been evaluating on every login since migration 0007.
UPDATE seat s
   SET is_administration = true
  FROM department d
 WHERE d.department_id = s.department_id
   AND d.is_administration
   AND NOT s.is_administration;

-- A seat filed under no department at all was district tier by migration 0010's rule, but it was
-- never *administration* — the control room's own post is not the DC Office. Left false on purpose.

CREATE INDEX IF NOT EXISTS seat_administration
    ON seat (is_administration) WHERE is_administration;

--------------------------------------------------------------------------------
-- 2. The tier trigger reads the checkbox instead of the join
--------------------------------------------------------------------------------
--
-- Migration 0010 derived `seat.tier` from the department, and enforced it with a trigger rather
-- than trusting callers, because a tier that drifts out of step with `is_administration` is a
-- silent widening of who may read what. That reasoning is unchanged. Only the source moves.
--
-- The rule is the same one, restated against the new column:
--
--   district  — the seat is an administrative office, or belongs to no department at all
--   department — everything else
--
-- The second clause is kept alive for the seats that still carry a `department_id` from before
-- this migration. Nothing new writes one.

-- ⚠️ THE DEPARTMENT CLAUSE STAYS, AND DROPPING IT IS A SILENT RE-SCOPING.
--
-- The first draft of this function read `NEW.is_administration` alone, and it was wrong in
-- the direction that matters: `createPost` files a seat under a department without setting
-- the column, so an office that has been administrative since migration 0007 would come out
-- `department` tier the next time anything touched its row — and `evaluateRead` keys on tier.
-- The backfill in §1 covers what exists; it cannot cover what is written afterwards.
--
-- So the rule is the union of the two sources while both exist. Once nothing carries a
-- `department_id` the third clause is unreachable and comes out in one line.

CREATE OR REPLACE FUNCTION seat_tier_from_department()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.is_administration
       OR NEW.department_id IS NULL
       OR EXISTS (
            SELECT 1 FROM department d
             WHERE d.department_id = NEW.department_id AND d.is_administration
          )
    THEN
        NEW.tier := 'district';
    ELSE
        NEW.tier := 'department';
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION seat_tier_from_department() IS
    'ADR-0029, amending ADR-0010: a seat is district tier iff it carries the administration tick, or is filed under no department. Not a caller''s choice.';

DROP TRIGGER IF EXISTS seat_tier_enforced ON seat;
CREATE TRIGGER seat_tier_enforced
    BEFORE INSERT OR UPDATE OF tier, department_id, is_administration ON seat
    FOR EACH ROW
    EXECUTE FUNCTION seat_tier_from_department();

-- Re-derive every existing row through the new source. Expected to change nothing — §1's backfill
-- makes the two expressions equivalent — and run anyway, because "expected to change nothing" is
-- the sentence that precedes most silent drift.
UPDATE seat SET tier = tier;

--------------------------------------------------------------------------------
-- 3. Vacant posts leave the list — and `vacant` is NOT `no_number`
--------------------------------------------------------------------------------
--
-- The district said to drop them, reversing ADR-0023's "a vacant post stays in the list, marked".
-- Safe to reverse: ADR-0023 kept vacancies so that **a vacant post could never swallow an
-- obligation** — ticked, recorded as told, nobody told — and a row that cannot be ticked cannot
-- swallow anything. What is actually given up is that the district stops being told which of its
-- seats are empty, which is their call and they have made it.
--
-- 🔴 THE CORRECTION THAT MADE THIS MORE THAN ONE LINE OF SQL
--
-- Of Bajaur's 81 rows, **38 have no phone number** and only **34 are vacant**. The other four hold
-- a named officer whose number was never recorded:
--
--     Rescue 1122 — District Emergency Officer     (named officer, example)
--     Civil Defence — CDO                          Shahid
--     DHQ Hospital — Associate Hospital Director   Dr. Saleem
--     Traffic Police — SP Traffic                  Fazal Ud Din
--
-- Written as "delete the rows with no number", this statement would have taken **Rescue 1122's
-- District Emergency Officer off the district's contact list** — the first number anybody reaches
-- for at 02:00. `domain/recipients.ts` already separates `vacant` from `no_number`; the predicate
-- below binds to **no current holder**, and those four stay. They are R-01.
--
-- RETIRED, NOT DELETED — and this is not a hedge
--
-- "Delete" is what the district means and retiring is what they get: `retired_at IS NOT NULL` is
-- already filtered out of the directory, the picker, the roster and the escalation ladder, so the
-- row is gone from every screen and every list. The row itself must stay, because past incidents
-- name their seats, and DELETE would either break those references or rewrite the record — which
-- ADR-0001 does not permit and ADR-0029 §6 explicitly promises not to do.

UPDATE seat s
   SET retired_at = now()
 WHERE s.retired_at IS NULL
   AND NOT EXISTS (
         SELECT 1 FROM duty_assignment d
          WHERE d.seat_id = s.seat_id AND d.to_at IS NULL
       );

--------------------------------------------------------------------------------
-- 4. What is deliberately NOT done here
--------------------------------------------------------------------------------
--
-- **`sla_target` is untouched.** `department_id` has been nullable since migration 0007 and the
-- district-default rows (`department_id IS NULL`) already exist and already carry the install
-- defaults. Once the code stops keying on a department, the per-department rows are simply never
-- read again. Deleting them would be tidying a table at the cost of a decision somebody may have
-- made, and R-03 is still open.
--
-- **`department` is not dropped.** The table, the ids and every `department_ids` written onto a
-- past `routed` event stay for ever (ADR-0001, ADR-0029 §6). This is the fourth time this project
-- has removed a structure this way — ADR-0018's inbox, ADR-0022's routing signals, ADR-0023's
-- picker rows — and the pattern is always the same: **the type survives so the past stays
-- readable, and nothing new is written into it.**
--
-- **`seat.department_id` is not nulled.** Same reason. Existing seats keep the department they
-- were filed under; new contacts are created with NULL.

INSERT INTO schema_migration (version) VALUES ('0038_contacts_without_departments')
ON CONFLICT (version) DO NOTHING;

COMMIT;
