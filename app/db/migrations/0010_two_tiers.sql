-- 0010 — the ladder has two rungs, and the seat table now says so (M1a-09, ADR-0010).
--
-- `tier` has carried four values since migration 0003: station, tehsil, district,
-- provincial. That was a generic hierarchy invented before anybody had told us how Bajaur is
-- organised, and ADR-0010 replaced it with the district's own answer: **two offices are the
-- authority, everything else is a department, and there is no third rung.**
--
-- Collapsing the enum was filed as a follow-up rather than a prerequisite. It stops being
-- cosmetic here, because of what the district's own data turned out to look like.
--
--------------------------------------------------------------------------------
-- What this fixes, and it is not tidiness
--------------------------------------------------------------------------------
--
-- Every one of the 83 seats loaded from the district's contact list is `district` tier.
--
-- Not a decision anybody made. The contact list has no tier column, so `ops/directory.ts`
-- defaulted every row — and `evaluateRead` widens at tehsil, meaning **tehsil and above may
-- read every incident in the district**. The consequence, live in the loaded roster right
-- now: the Education department's duty officer can read Rescue 1122's incidents, and the
-- Agriculture Extension officer can read the DPO's.
--
-- `docs/04-authority-model.md` says cross-department access is denied by default. In the
-- district's real data it is currently denied to nobody. A default I introduced, not a fact
-- the district supplied, which is why this migration corrects it rather than reporting it
-- and waiting.
--
--------------------------------------------------------------------------------
-- The rule
--------------------------------------------------------------------------------
--
-- A seat is `district` when it belongs to an administrative office (ADR-0010), or when it
-- belongs to no department at all — the control room and any district-wide post, for which
-- `department_id IS NULL` is how "not one department's" is already expressed.
--
-- Everything else is `department`.
--
-- Enforced by a trigger rather than left to callers. The API already refuses to let a
-- department create a post above its own rung, but a tier that can drift out of step with
-- `is_administration` is a silent widening of who can read what, and that is precisely the
-- class of bug worth spending ten lines of plpgsql on.

BEGIN;

--------------------------------------------------------------------------------
-- Widen the constraint, convert, then narrow it
--------------------------------------------------------------------------------

ALTER TABLE seat DROP CONSTRAINT IF EXISTS seat_tier_check;

-- station and tehsil both become `department`. Neither ever meant anything here: no row in
-- the district's data chose either, and the escalation ladder was expressed in terms of the
-- two rungs from the day ADR-0010 was accepted.
UPDATE seat SET tier = 'department' WHERE tier IN ('station', 'tehsil');
UPDATE seat SET tier = 'district'   WHERE tier = 'provincial';

-- Now the correction. Derive every tier from what ADR-0010 says decides it.
UPDATE seat s
   SET tier = CASE
                WHEN s.department_id IS NULL THEN 'district'
                WHEN EXISTS (
                       SELECT 1 FROM department d
                        WHERE d.department_id = s.department_id
                          AND d.is_administration
                     ) THEN 'district'
                ELSE 'department'
              END;

ALTER TABLE seat
    ADD CONSTRAINT seat_tier_check CHECK (tier IN ('department', 'district'));

--------------------------------------------------------------------------------
-- And keep it that way
--------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION seat_tier_from_department()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.department_id IS NULL THEN
        NEW.tier := 'district';
    ELSIF EXISTS (
            SELECT 1 FROM department d
             WHERE d.department_id = NEW.department_id AND d.is_administration
          ) THEN
        NEW.tier := 'district';
    ELSE
        NEW.tier := 'department';
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION seat_tier_from_department() IS
    'ADR-0010: a seat is district tier iff its office is administrative, or it has none. Not a caller''s choice.';

DROP TRIGGER IF EXISTS seat_tier_enforced ON seat;
CREATE TRIGGER seat_tier_enforced
    BEFORE INSERT OR UPDATE OF tier, department_id ON seat
    FOR EACH ROW
    EXECUTE FUNCTION seat_tier_from_department();

INSERT INTO schema_migration (version) VALUES ('0010_two_tiers')
ON CONFLICT (version) DO NOTHING;

COMMIT;
