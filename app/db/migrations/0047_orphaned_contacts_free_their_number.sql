-- 0047 — a contact deleted before dnc-shell-v208 no longer holds its phone number.
--
-- THE BUG, reported from Bajaur twice: delete a contact, try to add the same one back, and the
-- form refuses with "a contact with that phone number already exists" about a contact that is
-- off every screen.
--
-- WHY. A contact is a `seat` and its one holder, created together (ADR-0029). The old
-- `removeContact` retired the seat and closed the duty assignment but left the `person` row
-- with `removed_at` NULL — and `createContact`'s phone-duplicate check reads
--
--     SELECT 1 FROM person WHERE removed_at IS NULL AND (phone = $1 OR right(digits, 10) = $2)
--
-- -- so the deleted contact's number stayed claimed for ever. `db/rosterStore.ts` was fixed in
-- v208 (`removeContact` now marks the holder `removed_at = now()` when they hold no other live
-- seat, the same shape as `removePerson`), and `contacts.test.ts` test 8 covers it — but a code
-- fix cannot reach back to the rows the old code already left behind. On 2026-09-03 Bajaur's
-- database held 14 such ghosts, every one a test contact the owner had added and deleted.
--
-- This is migration 0045's situation for the directory instead of for accounts: "every number
-- freed by a past removal is usable again the moment this runs."
--
-- THE PREDICATE matches only the bug. A person is freed when they:
--   * are not already removed (`removed_at IS NULL`),
--   * have held at least one contact-seat (so a parked directory person with no post is never
--     touched), and
--   * hold no live assignment to a seat that is still on the books.
-- That is exactly `removeContact`'s own "when they hold no other live seat" test, applied once
-- to the whole table. `disabled_at` is set the same way `removeContact` sets it, so any login a
-- ghost row carried is closed too.
--
-- ⚠️ NO GUARD, NO `RAISE`, NO `EXCEPTION` (O-40). There is nothing to refuse over — a
-- deterministic `UPDATE` of rows that should already have been in this state. `person` carries
-- no append-only trigger (it is current state, not the event log), so this rewrites no
-- protected history — migration 0027 / 0046 stood on the same footing. On a fresh database
-- (`freshDatabase.ts`) it touches zero rows.

BEGIN;

UPDATE person p
   SET removed_at = now(),
       disabled_at = coalesce(p.disabled_at, now())
 WHERE p.removed_at IS NULL
   AND EXISTS (
     SELECT 1 FROM duty_assignment d WHERE d.person_id = p.person_id
   )
   AND NOT EXISTS (
     SELECT 1
       FROM duty_assignment d
       JOIN seat s ON s.seat_id = d.seat_id
      WHERE d.person_id = p.person_id
        AND d.to_at IS NULL
        AND s.retired_at IS NULL
   );

INSERT INTO schema_migration (version) VALUES ('0047_orphaned_contacts_free_their_number')
ON CONFLICT (version) DO NOTHING;

COMMIT;
