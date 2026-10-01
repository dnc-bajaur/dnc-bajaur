-- 0040 — group picture / avatar support
--
-- Adds optional profile picture / avatar column to recipient_group table.

BEGIN;

ALTER TABLE recipient_group
    ADD COLUMN IF NOT EXISTS picture text;

INSERT INTO schema_migration (version) VALUES ('0040_group_picture')
ON CONFLICT (version) DO NOTHING;

COMMIT;
