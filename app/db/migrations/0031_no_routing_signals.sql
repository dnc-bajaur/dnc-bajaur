-- 0031 — the district assigns by hand, so nothing routes on its own any more
--
-- ADR-0022 reverses the mechanism half of ADR-0010. The two administrative offices still own
-- the district and still configure it; what they no longer configure is **where an emergency
-- goes**. The control room chooses, on the call, every time.
--
-- WHY, IN THE DISTRICT'S OWN WORDS
--
-- The control room is not a technical room. They were already assigning by hand — ADR-0016
-- made that the design on 2026-08-05 — and a second mechanism that pre-decided the same
-- question on their behalf did not help them, it confused them: a screen that had already
-- ticked something, for a reason written by somebody else, on a night when they were the
-- ones who knew where the fire was. The signals were never a shortcut they asked for.
--
-- WHAT THIS COSTS, STATED PLAINLY
--
-- ⚠️ CORRECTED 2026-08-20, AFTER THIS MIGRATION RAN. The paragraph below is wrong, and the
-- guard further down is what proved it wrong: Bajaur held ONE live signal — `fire incident` to
-- Assistant Commissioner Bajaur, written 2026-08-17. This migration refused to run, and because
-- migrations run at boot, that refusal took the district off the air for 34 minutes. The SQL is
-- unchanged and correct; only this comment is added, because the file had already been applied
-- and a false claim left where somebody will read it is worse than an amended comment. The
-- placement fix is O-40.
--
-- Nothing today. `routing_signal` has held **zero live rows for the whole life of this
-- installation** — R-04 was open from 2026-08-02 to the day this ran, and every emergency
-- Bajaur has ever recorded was assigned by a person. This migration is not throwing away
-- district configuration; it is removing a table the district never filled.
--
-- WHY IT STILL REFUSES IF THERE IS ANYTHING IN IT
--
-- Because "it was empty when I looked" is not the same claim as "it is empty", and the gap
-- between them is a district's configuration. If a signal exists when this runs, the
-- migration stops and says so, and somebody decides deliberately rather than finding out
-- afterwards. This is the same instinct as INV-06: a destructive step states its case first.
--
-- WHAT IS DELIBERATELY LEFT ALONE
--
-- `config_event` keeps every `routing_signal` row it ever wrote, and its CHECK still names
-- that subject. The log is append-only and outliving its subject is the entire point of a
-- record (0007's own comment says so). A district asking in six months *"who added the rule
-- that sent the bazaar fire to Irrigation"* must still get an answer, and dropping the
-- history to tidy the schema would be the one loss this change cannot justify.
--
-- Incident events are untouched for the same reason. `routed` events written by the
-- automatic pass — including empty ones — stay exactly as they were recorded, and the fold
-- in `domain/incident.ts` still reads them (INV-08).

BEGIN;

DO $$
DECLARE
    live_signals bigint;
BEGIN
    IF to_regclass('public.routing_signal') IS NULL THEN
        RETURN;
    END IF;

    SELECT count(*) INTO live_signals FROM routing_signal WHERE retired_at IS NULL;

    IF live_signals > 0 THEN
        RAISE EXCEPTION
            'routing_signal holds % live row(s). ADR-0022 removes routing on the understanding that the district never configured any. Read them, decide deliberately, then retire them before running this.',
            live_signals;
    END IF;
END
$$;

DROP TABLE IF EXISTS routing_signal;

INSERT INTO schema_migration (version) VALUES ('0031_no_routing_signals')
ON CONFLICT (version) DO NOTHING;

COMMIT;
