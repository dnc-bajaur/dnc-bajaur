-- Searching the record by when things happened — capability group 9.
--
-- Full-history search asks "what happened during last year's floods", and that is a question
-- about **occurred_at**, not recorded_at. The project's own rule already says so: measurement
-- uses occurred_at, escalation firing uses recorded_at (docs/02-connectivity-ladder.md).
--
-- The distinction is not academic here, it is the whole of ADR-0002. A report captured on a
-- handset with no signal in March and delivered in August has `occurred_at` in March and
-- `recorded_at` in August. Searching on recorded_at would file that emergency under the day
-- the network came back — so the district's worst weeks, the ones where devices were offline
-- longest, would be exactly the weeks that searched emptiest.
--
-- `incident_event_by_recorded` already serves the board, which is right to use recorded_at:
-- it asks "what has arrived lately". Nothing indexed occurred_at across incidents, because
-- until now nothing needed to scan a date range over the whole log.

BEGIN;

CREATE INDEX IF NOT EXISTS incident_event_by_occurred
    ON incident_event (occurred_at, incident_id);

-- Record it. This line was missing until 2026-08-05, and `migrate()` keys on this table alone
-- — so this migration was **re-applied on every single boot**, for ever. It survived only
-- because `CREATE INDEX IF NOT EXISTS` does nothing the second time, and the cost was a
-- startup log line announcing a schema change that had not happened.
--
-- Found by running the installer's first-run twice against one machine, which is the first
-- thing in this project that ever ran `migrate` against a database that was already current.
-- Every test starts from a fresh cluster, so nothing else could have seen it.
INSERT INTO schema_migration (version) VALUES ('0019_search_by_occurrence')
ON CONFLICT (version) DO NOTHING;

COMMIT;
