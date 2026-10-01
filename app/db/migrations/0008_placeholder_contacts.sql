-- 0008 — a contact number that is known to be a stand-in says so.
--
-- The district's contact list has gaps, the biggest being **Rescue 1122**, whose District
-- Emergency Officer is named with no number. That gap has been blocking a demonstration of
-- the full incident lifecycle, and the owner's instruction is not to wait for it: put
-- something in, keep moving, and correct it from the console later.
--
-- Right instruction. But "put 1111111 in and move on" has a failure mode this project exists
-- to prevent: **a fake number is indistinguishable from a real one.** It looks like a
-- contact, it renders like a contact, the vacant-post warning disappears, and the first time
-- anybody finds out is when an alert for a bazaar fire is dialled into nothing at 02:00.
--
-- So the number goes in, and the fact that it is a stand-in goes in beside it. A placeholder
-- contact:
--
--   * fills the post, so the roster is complete and editable
--   * is labelled as a placeholder everywhere it is shown
--   * is **never dialled, messaged, or counted as reached** — the notifier treats it as an
--     unmet obligation, exactly as it treats a vacant post today (INV-03, ADR-0005)
--
-- The moment somebody types the real number over it, the flag clears and it becomes an
-- ordinary contact. Nothing else has to change.

BEGIN;

ALTER TABLE person
    ADD COLUMN IF NOT EXISTS placeholder boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN person.placeholder IS
    'The number is a stand-in, not this person''s. Never notify; always label. Cleared when a real number is entered.';

-- Rescue 1122's District Emergency Officer.
--
-- A post named in the district's own list with no number given. The post is
-- filled here so M1 can proceed, and filled visibly so nobody mistakes it for done.
--
-- Idempotent, and it does nothing at all if the post has since been given a real holder.
WITH deo AS (
    SELECT s.seat_id
      FROM seat s
      JOIN department d ON d.department_id = s.department_id
     WHERE d.name ILIKE 'Rescue 1122%'
       AND s.title ILIKE '%Emergency Officer%'
       AND NOT EXISTS (
             SELECT 1 FROM duty_assignment da
              WHERE da.seat_id = s.seat_id AND da.to_at IS NULL
           )
     LIMIT 1
),
contact AS (
    INSERT INTO person (full_name, phone, placeholder)
    SELECT 'Name not yet given', '1111111', true
      FROM deo
    RETURNING person_id
)
INSERT INTO duty_assignment (seat_id, person_id)
SELECT deo.seat_id, contact.person_id FROM deo, contact;

INSERT INTO schema_migration (version) VALUES ('0008_placeholder_contacts')
ON CONFLICT (version) DO NOTHING;

COMMIT;
