-- 0016 — one app, so no separate credential for a screen (M4).
--
-- 0015 created `wall_screen`: an identity a television could sign in as, to read a display
-- built as its own page at `/display`. That page is gone, and this goes with it.
--
-- Why it was wrong. The owner's instruction, 2026-08-03:
--
--   > ye software just mobile ya laptop k lye nhe hai … ye mobile, laptop ya barre screen sub
--   > pr fit and zabardast chalega … tum multiple screens bana kr complecated and messy naa
--   > banao
--
-- One application, which recognises the device it is on and lays itself out accordingly. A
-- large screen in the DC office is a person signing in like any other person — so the second
-- kind of credential, the second page, and the second set of numbers that could drift from
-- the first were all solving a problem that only existed because I had split the app in two.
--
-- The rest of 0015 stays and is doing real work: `utility`, `utility_report`,
-- `presence_report` and `weather_reading` are what the dashboard is *made of*, on every size
-- of screen. Only the credential was a consequence of the mistake.
--
-- Dropped rather than left in place. An unused table with a token column is an authentication
-- path nobody is maintaining, and the next person to find it would reasonably assume it was
-- load-bearing.

BEGIN;

DROP TABLE IF EXISTS wall_screen;

-- `wall_screen` can no longer be the subject of a change. Rows already written keep their
-- text — the log is append-only (ADR-0001), and a constraint that rejected history would be
-- a constraint that lies about what happened.
ALTER TABLE config_event DROP CONSTRAINT IF EXISTS config_event_subject_known;
ALTER TABLE config_event
    ADD CONSTRAINT config_event_subject_known
    CHECK (subject IN ('department', 'routing_signal', 'sla_target', 'seat', 'person', 'duty',
                       'resource', 'channel_ladder', 'utility', 'wall_screen'));

INSERT INTO schema_migration (version) VALUES ('0016_no_wall_screens')
ON CONFLICT (version) DO NOTHING;

COMMIT;
