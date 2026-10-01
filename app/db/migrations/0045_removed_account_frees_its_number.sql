-- 0045 — a removed account no longer holds its phone number.
--
-- The bug, reported from Bajaur's own Settings panel: add an account, remove it, and its phone
-- number can never be used for another account again — "that phone number already has an
-- account" — while the account itself is gone from every screen.
--
-- Why. `removeAccount` (ADR-0001) does not DELETE the row; it sets `removed_at` so the person,
-- their access history and every incident they touched stay readable. `password_hash` is left
-- in place for the same reason. But migration 0006's uniqueness index —
--
--     CREATE UNIQUE INDEX person_phone_account_unique
--         ON person (phone) WHERE password_hash IS NOT NULL;
--
-- -- still counts that removed row, so the number stays claimed. `listAccounts` and
-- `loadAccount` both filter `removed_at IS NULL`, so nothing surfaces the ghost that is
-- blocking the insert.
--
-- The fix is the predicate. "One account per phone" is a rule about accounts that can sign in,
-- and a removed account cannot (sessions.ts filters `removed_at IS NULL` when resolving the
-- identity, and this migration adds the same filter to the login candidate query in the same
-- change). So the partial index gains `AND removed_at IS NULL`, and every number freed by a
-- past removal — Bajaur's included — is usable again the moment this runs. No data is touched.
--
-- ⚠️ NO GUARD, NO `RAISE`, NO `EXCEPTION` (O-40). This only redefines an index.

BEGIN;

DROP INDEX IF EXISTS person_phone_account_unique;

CREATE UNIQUE INDEX IF NOT EXISTS person_phone_account_unique
    ON person (phone)
    WHERE password_hash IS NOT NULL AND removed_at IS NULL;

INSERT INTO schema_migration (version) VALUES ('0045_removed_account_frees_its_number')
ON CONFLICT (version) DO NOTHING;

COMMIT;
