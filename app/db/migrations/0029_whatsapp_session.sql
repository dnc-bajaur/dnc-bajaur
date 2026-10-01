-- 0029 — the 24-hour service window, and a question the district is waiting on an answer to
--
-- WHY THIS EXISTS AT ALL
--
-- Every WhatsApp message this system has ever sent has been an approved template, because
-- Meta's rule is that the FIRST message of a conversation must be one. That rule has quietly
-- shaped the whole product: anything the district wanted to ask an officer had to be a button
-- approved weeks earlier, or a link out of WhatsApp into a browser on a district signal at
-- 02:00 — which is the thing the owner has now said, plainly, must stop.
--
-- The rule has a second half that this codebase has never used. The moment a recipient sends
-- ANYTHING back — a typed word, a tap on a quick reply — a 24-hour service window opens on
-- that number, and inside it the district may send free-form messages: plain text, or an
-- interactive message with its own buttons. No template. No approval. No waiting on Meta.
--
-- So the follow-up questions the district could never ask are askable the instant an officer
-- answers, and they are askable INSIDE WhatsApp. That is the whole unlock, and these two
-- tables are the smallest thing that makes it safe.
--
-- WHY THESE ARE TABLES AND NOT THE EVENT LOG
--
-- The same reasoning as `whatsapp_message` and `ack_token` in 0021, which the store file sets
-- out at length: both of these are facts that CHANGE, and an append-only log cannot answer
-- "is the window open right now" or "is this question still waiting" without folding history
-- on every inbound message. Neither is history. Everything either of them causes — the
-- question being asked, the answer arriving — is still appended to the incident's log as an
-- `action_logged` event, which is where the district's record lives. Drop both tables and the
-- district loses the ability to interpret the NEXT reply; it loses no record of anything that
-- has already happened.

BEGIN;

-- WHEN THIS NUMBER LAST SAID SOMETHING TO US
--
-- One row per number, overwritten. There is deliberately no history here: the only question
-- this table answers is "may we send a free-form message to this number right now", and that
-- is a function of the LAST inbound and nothing before it.
--
-- Keyed by phone rather than by person, and that is not this codebase forgetting Q-19. Two
-- officers in Bajaur share a handset and this system refuses to identify anybody by number —
-- but a service window is genuinely a fact about the NUMBER. Meta opens it per number, and
-- whoever is holding the handset is who the follow-up reaches. Nothing here is used to decide
-- who somebody is; it decides only whether Meta will accept the message.
CREATE TABLE IF NOT EXISTS whatsapp_window (
    -- Digits, international form, exactly as `toE164` writes them everywhere else. A number
    -- stored two ways is a window that looks shut while it is open.
    phone           text        PRIMARY KEY,

    -- Meta's own timestamp on the inbound message, not our clock. A webhook can be retried or
    -- delayed for hours, and dating the window from the moment WE processed it would claim
    -- more time than Meta will actually honour.
    last_inbound_at timestamptz NOT NULL
);

-- THE QUESTION THE DISTRICT HAS ASKED AND IS WAITING ON
--
-- When an officer taps "Sending someone", the district needs a name, and the name cannot be a
-- button — it is a person, typed. So the follow-up is a plain-text question, and the officer's
-- NEXT typed message is its answer.
--
-- That inference has to be written down somewhere before it happens, or the reply arrives and
-- looks exactly like every other reply: a deliberate act by somebody who was told about an
-- emergency, which `recordReply` would record as an acknowledgement of whatever was last sent
-- to that number. The district would end up with "Replied on WhatsApp: Nasir Khan" against a
-- meeting, and no answer to the question it actually asked.
CREATE TABLE IF NOT EXISTS whatsapp_question (
    question_id uuid        PRIMARY KEY,

    -- Who we asked. Same form as `whatsapp_window.phone`.
    phone       text        NOT NULL,

    -- What it is about. Not foreign keys, for the reason 0021 gives: attempts live in the
    -- event log, which has no row to reference.
    incident_id uuid        NOT NULL,
    attempt_id  uuid        NOT NULL,

    -- Which question. One value today; named rather than assumed so that the second one is a
    -- new value here and not a second table.
    asks        text        NOT NULL CHECK (asks IN ('substitute')),

    asked_at    timestamptz NOT NULL DEFAULT now(),

    -- A question does not wait for ever. Past this, a typed reply is an ordinary reply again —
    -- the officer has moved on, and attaching a sentence they wrote on Thursday to a meeting
    -- they answered on Monday would be inventing the district's record. Set from the service
    -- window, because past the window we could not have asked anyway.
    expires_at  timestamptz NOT NULL,

    -- Null until answered. NOT deleted on answer: the district should be able to see that it
    -- asked, even when nobody replied, which is exactly the failure worth surfacing.
    answered_at timestamptz,
    answer      text
);

-- Finding the one question a number still owes an answer to. Partial, because an answered
-- question is never looked up this way and Bajaur will accumulate them for years.
CREATE INDEX IF NOT EXISTS whatsapp_question_waiting
    ON whatsapp_question (phone, asked_at DESC)
    WHERE answered_at IS NULL;

INSERT INTO schema_migration (version) VALUES ('0029_whatsapp_session')
ON CONFLICT (version) DO NOTHING;

COMMIT;
