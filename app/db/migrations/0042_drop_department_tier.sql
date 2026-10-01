-- 0042 — the lower seat tier stops being called `department` (ADR-0031).
--
-- ADR-0030 dropped the department table but left `seat.tier` carrying the value `department`
-- and the trigger function still named `seat_tier_from_department`. Migration 0039's own note
-- said the rename was deferred because `tier` is read by `evaluateRead`, the escalation ladder
-- and four API modules, and a rename touching all of them belongs in a change somebody can
-- review as one thing. ADR-0031 is that change: there are no departments anywhere in the
-- product, so the ordinary seat is a `post` and the two administrative offices are `district`.
--
-- ⚠️ NO GUARD, NO `RAISE`, NO `EXCEPTION` — O-40's lesson. A migration that can refuse runs at
-- boot and takes the district off the air. This one only renames a value and a function; it
-- cannot fail on the district's data.
--
-- ORDER MATTERS. The trigger fires `BEFORE UPDATE OF tier`, so the row UPDATE below would be
-- re-derived by the trigger. The function is replaced FIRST so that re-derivation lands on
-- `post`, then the constraint is widened, then the rows move, then the constraint is tightened.

BEGIN;

--------------------------------------------------------------------------------
-- 1. The trigger function reads the new vocabulary
--------------------------------------------------------------------------------
--
-- Renamed `seat_tier_from_department` -> `seat_tier`. The trigger keeps its name
-- (`seat_tier_enforced`) so nothing that inspects triggers by name has to change, and it is
-- still `BEFORE INSERT OR UPDATE OF tier, is_administration` — authority reading a column
-- somebody ticked, never a name somebody typed (ADR-0029 §2).

DROP TRIGGER IF EXISTS seat_tier_enforced ON seat;

CREATE OR REPLACE FUNCTION seat_tier()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.tier := CASE WHEN NEW.is_administration THEN 'district' ELSE 'post' END;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION seat_tier() IS
    'ADR-0031, amending ADR-0010/0030: a seat is district tier iff it carries the administration tick; otherwise it is a post. Not a caller''s choice.';

CREATE TRIGGER seat_tier_enforced
    BEFORE INSERT OR UPDATE OF tier, is_administration ON seat
    FOR EACH ROW EXECUTE FUNCTION seat_tier();

DROP FUNCTION IF EXISTS seat_tier_from_department();

--------------------------------------------------------------------------------
-- 2. The value moves: `department` -> `post`
--------------------------------------------------------------------------------
--
-- The constraint is dropped before the rows move (the old one forbids `post`) and re-added
-- after. The UPDATE re-fires the trigger, which now produces `post` for every non-admin seat,
-- so the SET is really only naming what the trigger already decides.

ALTER TABLE seat DROP CONSTRAINT IF EXISTS seat_tier_check;

UPDATE seat SET tier = 'post' WHERE tier = 'department';

ALTER TABLE seat
    ADD CONSTRAINT seat_tier_check CHECK (tier IN ('post', 'district'));

INSERT INTO schema_migration (version) VALUES ('0042_drop_department_tier')
ON CONFLICT (version) DO NOTHING;

COMMIT;
