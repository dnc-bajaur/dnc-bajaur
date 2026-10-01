-- 0041 — contact picture / avatar support
--
-- Adds optional profile picture / avatar column to person table.

BEGIN;

ALTER TABLE person
    ADD COLUMN IF NOT EXISTS picture text;

INSERT INTO schema_migration (version) VALUES ('0041_contact_picture')
ON CONFLICT (version) DO NOTHING;

COMMIT;
