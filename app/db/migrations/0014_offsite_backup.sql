-- 0014 — where the off-site copy went, and whether it got there (M0-53, ADR-0011).
--
-- The backup ledger from migration 0004 records that a dump was taken and verified on the DC
-- office's own disk. That covers a bad restore and a corrupted table; it does not cover the
-- building. ADR-0011 sends a nightly encrypted copy to Google Cloud, and this is where the
-- fact that it arrived — or did not — is recorded.
--
-- Three columns rather than one boolean, because three different things need to be told
-- apart and a boolean cannot:
--
--   offsite_at IS NULL, offsite_error IS NULL   → not attempted yet (a run in flight)
--   offsite_at IS NULL, offsite_error IS NOT    → attempted and failed, or deliberately
--                                                 skipped because there is no bucket (R-06)
--   offsite_at IS NOT NULL                      → it is out of the building
--
-- **"We did not try" must never render the same as "it worked."** That distinction is the
-- entire point of the column, and it is what stops a district believing its record is safe
-- for a year and finding out on the day it is not.

BEGIN;

ALTER TABLE backup_run ADD COLUMN IF NOT EXISTS offsite_key   text;
ALTER TABLE backup_run ADD COLUMN IF NOT EXISTS offsite_at    timestamptz;
ALTER TABLE backup_run ADD COLUMN IF NOT EXISTS offsite_error text;

-- The question `/health` and the console ask: when did a dump last actually leave the
-- district? Partial, because the rows that never made it are irrelevant to that question and
-- are the majority until R-06 arrives.
CREATE INDEX IF NOT EXISTS backup_run_offsite
    ON backup_run (offsite_at DESC) WHERE offsite_at IS NOT NULL;

INSERT INTO schema_migration (version) VALUES ('0014_offsite_backup')
ON CONFLICT (version) DO NOTHING;

COMMIT;
