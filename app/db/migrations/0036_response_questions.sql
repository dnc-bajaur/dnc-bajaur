-- 0036 — the district's response workflow asks FOUR more kinds of question
--
-- 0029 built `whatsapp_question` with one value in its CHECK and said in its own comment that the
-- second would be a new value here rather than a second table. 0030 was that second. This is the
-- third and fourth, and they arrive together because they arrive from one document.
--
-- WHAT ASKS THEM
--
-- The district's *Official WhatsApp Response and Acknowledgement Workflow*, received 2026-08-24.
-- After an officer acknowledges, they are offered their category's options, and two of those
-- options are questions rather than statements:
--
--   * `clarification` — *"Further Information Required"*, *"Further Clarification Required"* and
--     *"Information Requires Further Clarification"*. The district wrote, in three categories,
--     that the recipient **may enter a brief message**. This is that message.
--
--   * `reason` — *"Otherwise Unavailable"*. The one place their document says a reason is
--     **required** rather than optional: an officer who is neither sending a deputy nor on leave
--     has to say why they cannot act.
--
--   * `representative` — *"Sending a Responsible Representative"*. The SAME question `substitute`
--     already asks, kept apart from it for one reason that lands on a handset: what is said
--     afterwards. A meeting's substitute is answered with *"kindly make it convenient to attend"*;
--     an emergency's representative is answered with the district's closing sentence and the
--     control room's number. One kind for both would hand a meeting the emergency number, which
--     is the mistake `thanksKindFor` exists to prevent.
--
--   * `absence` — a meeting's *"Not Attending"*. Their §9 is the one category that already
--     worked end to end, and the single thing their document adds to it is a reason. The
--     BUTTON is untouched: it is approved at Meta by position on `district_notice_v2`, and
--     rewording it would mean resubmitting a template the district asked us not to touch.
--     What is new is the question that follows the tap.
--
-- WHY SEPARATE VALUES AND NOT ONE "free_text"
--
-- The same argument `askWhatHappened` makes for not sharing a helper with `askWhoIsComing`: these
-- are asked at different moments, about different things, and the answers are written onto the
-- incident in different words. One value would leave `recordReply` unable to tell a request for
-- more information from an officer explaining that their vehicle has broken down — and it would
-- write one of them into the record wearing the other's sentence.
--
-- ⚠️ NO TEMPLATE IS TOUCHED BY ANY OF THIS, AND THAT WAS THE DISTRICT'S FIRST CONDITION.
-- Every question above is a free-form message sent inside the 24-hour service window the
-- *Acknowledge* tap opens. Nothing is submitted to Meta and `npm run doctor` must still pass
-- unchanged.

BEGIN;

-- Dropped and recreated rather than added beside, exactly as 0030 did and for the reason it
-- recorded: a CHECK is not a list you append to, and two constraints on one column would BOTH
-- have to pass — so the old two-value check would silently forbid every clarification while the
-- new constraint sat there looking correct. Migration 0027 paid for this lesson once already.
ALTER TABLE whatsapp_question DROP CONSTRAINT IF EXISTS whatsapp_question_asks_check;
ALTER TABLE whatsapp_question DROP CONSTRAINT IF EXISTS whatsapp_question_asks_known;

ALTER TABLE whatsapp_question
    ADD CONSTRAINT whatsapp_question_asks_known
    CHECK (asks IN (
        'substitute', 'resolution', 'clarification', 'reason', 'representative', 'absence'
    ));

INSERT INTO schema_migration (version) VALUES ('0036_response_questions')
ON CONFLICT (version) DO NOTHING;

COMMIT;
