-- 0037 — the acknowledgement page can carry the district's response options too
--
-- WHY THE PAGE NEEDS THIS AT ALL
--
-- The district's response workflow (2026-08-24) runs inside WhatsApp's 24-hour service window,
-- which a **quick reply** opens and a **URL button does not**. Two of this district's live
-- templates carry a link and no quick reply:
--
--   * `district_message_img_v2` — anything with a photograph
--   * `district_message_v3`     — schedules, plain information, a cancelled meeting
--
-- An officer on either of those taps a link, lands on `/ack/:token`, and sends WhatsApp nothing.
-- No window opens, so the district cannot put a single further message in front of them. For
-- those two paths the page IS the workflow, and without this row they would be the only
-- messages in Bajaur that the district's own document does not apply to.
--
-- ⚠️ AND THIS IS WHY NO NEW TEMPLATE IS BEING SUBMITTED. A new image template with a quick reply
-- was considered and rejected: it would burn a template name, join a Meta review queue, and buy
-- nothing the page does not already give — the page has no 24-character row limit either, so it
-- shows the district's sentences at full length as the options themselves.
--
-- WHY A FOURTH STAGE AND NOT A REUSED ONE
--
-- `respond` and `resolve` move the emergency and `availability` says where a person is. A
-- response token does neither by itself: it authorises ONE act — choosing one of the district's
-- options — and what that then implies is decided in `responseOptions.ts`, per option. Squeezing
-- it into `respond` would mean a token minted to record *"Not Related to Me"* was also a token
-- that could mark an emergency as being dealt with.
--
-- 0026 wrote this same reasoning for `respond`/`resolve` and 0027 for `availability`. Same
-- pattern, same table, one more value.

BEGIN;

-- Dropped and recreated rather than added beside, exactly as 0027 did: a CHECK is not a list you
-- append to, and two constraints on one column would BOTH have to pass — so 0027's four-value
-- check would silently forbid every response token while the new constraint sat there looking
-- correct.
ALTER TABLE ack_token DROP CONSTRAINT IF EXISTS ack_token_stage_known;
ALTER TABLE ack_token DROP CONSTRAINT IF EXISTS ack_token_stage_known_v2;

ALTER TABLE ack_token
    ADD CONSTRAINT ack_token_stage_known_v3
    CHECK (stage IN ('acknowledge', 'respond', 'resolve', 'availability', 'response'));

INSERT INTO schema_migration (version) VALUES ('0037_response_token')
ON CONFLICT (version) DO NOTHING;

COMMIT;
