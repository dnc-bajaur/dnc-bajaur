-- 0020 — the control room's own provenance, beside the automatic one (M6-05).
--
-- Two event types arrive with this migration and neither of them needs a column, because the
-- event store has held arbitrary payloads since 0001 and that is the point of it. What they
-- need is for the questions they create to be answerable without a sequential scan of the log:
--
--   * "who has been told about this incident"        — folded per incident, already indexed
--   * "what is waiting in my inbox"                  — across the whole log, by addressee
--   * "how many incidents has nobody been told about" — across the whole log, by type
--
-- The second and third are new, and both were about to be answered by reading every row.
--
--------------------------------------------------------------------------------
-- 1. The inbox has a second addressee
--------------------------------------------------------------------------------
--
-- `notified` events used to be addressed only to a seat. M6-03 adds `personId`, because the
-- district asked to tell named individuals and a post is a different thing: a post is held by
-- whoever holds it tonight, so an obligation recorded against one silently becomes somebody
-- else's message at the next shift change.
--
-- The inbox query now matches either. Without an index that is a full scan of `incident_event`
-- on **every poll from every signed-in client**, which is the one query in this system whose
-- cost is multiplied by how many officers are actually using it. It was already a scan for the
-- seat half; that was survivable at 11,000 events and would not have been at a year's worth.
--
-- Two partial indexes rather than one composite, because a `notified` event has a seat or a
-- person and rarely both, and an index on a NULL half is bytes bought for nothing.

BEGIN;

CREATE INDEX IF NOT EXISTS incident_event_notified_by_seat
    ON incident_event ((payload->>'seatId'))
    WHERE type = 'notified';

CREATE INDEX IF NOT EXISTS incident_event_notified_by_person
    ON incident_event ((payload->>'personId'))
    WHERE type = 'notified' AND payload ? 'personId';

-- The other half of the inbox query: "has anything settled this attempt yet?". Also a scan
-- until now, and it runs once per candidate row.
CREATE INDEX IF NOT EXISTS incident_event_settlements_by_attempt
    ON incident_event ((payload->>'attemptId'))
    WHERE type IN ('notification_delivered', 'notification_failed');

--------------------------------------------------------------------------------
-- 2. The dispatch itself
--------------------------------------------------------------------------------
--
-- `dispatched` is deliberately **not** folded into `routed`, and this is the migration that
-- makes the distinction cheap enough to keep. Routing is the district's standing configuration
-- answering *which departments handle this kind of thing*; a dispatch is a named operator, on a
-- telephone call at 02:00, saying *tell Rescue, tell the DEO, and tell Nawaz*. One event type
-- carrying both would leave the record unable to answer **who decided this** — which is the
-- question the paper register is being replaced to answer.
--
-- The index serves the dashboard counter (M6-09): incidents where the control room has chosen
-- nobody are exactly the ones still living on somebody's personal handset.

CREATE INDEX IF NOT EXISTS incident_event_dispatched
    ON incident_event (incident_id, occurred_at)
    WHERE type = 'dispatched';

--------------------------------------------------------------------------------
-- 3. Contact attempts
--------------------------------------------------------------------------------
--
-- `contact_opened` reverses the "nothing is recorded" of 2026-08-03 (M6-10). That decision was
-- right when the panel was the only channel and wrong the moment the district needed to answer
-- *who was told about this*: an untraced contact is precisely the paper-register gap M6 exists
-- to close.
--
-- What has **not** changed, and must not be read back into this table: the event states only
-- that an app was opened. Nothing here observed a ring, an answer, or a conversation, and it
-- never settles an obligation. Only a deliberate act does (ADR-0014).

CREATE INDEX IF NOT EXISTS incident_event_contact_opened
    ON incident_event (incident_id, occurred_at)
    WHERE type = 'contact_opened';

INSERT INTO schema_migration (version) VALUES ('0020_dispatch')
ON CONFLICT (version) DO NOTHING;

COMMIT;
