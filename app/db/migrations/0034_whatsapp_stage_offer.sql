-- 0034 — which handset has already been offered the buttons, at which point in an emergency
--
-- WHAT THIS IS FOR
--
-- The owner tested Phase 8c on a real handset the day it shipped. The control room chased, the
-- officer typed **"It is resolved"**, and the emergency stayed on the board as *Responded*.
--
-- Two things were behind that, and this table is the second one. The first was that the
-- follow-up carried no buttons at all (Phase 9a). The second is that **a typed reply is never
-- read for meaning** — `webhooks.ts` records the words, settles the obligation and acknowledges,
-- and nothing anywhere looks at WHAT was said.
--
-- 🔴 THAT SECOND ONE IS NOT A BUG AND MUST NOT BE "FIXED" BY PARSING THE WORDS.
-- It was proposed on 2026-08-08 and refused, for reasons that have not weakened: *"not handled
-- yet"* contains *"handled"*; one recipient's reply is not every recipient's; closure needs a
-- reason from an overrider that a one-word reply cannot carry; and a real emergency marked done
-- because a reply was misread is a worse failure than the extra step. **A false auto-close is the
-- one outcome this district cannot afford.**
--
-- So the district does not guess. It **offers**: an officer who typed something, on an emergency
-- with a stage still ahead, gets the buttons back — and one tap runs the same safe machinery that
-- has existed since Phase C. No word list, no language problem, no false positive. The cost of
-- being wrong is one extra message; the cost of guessing is a closed emergency nobody attended.
--
-- WHY A TABLE, AND WHY THIS KEY
--
-- Without one, every reply gets a message back. An officer typing four times about one emergency
-- would be answered four times — which is chattiness the owner has already named as a thing to
-- watch (*"jab chat auto open ho jata hai … usay hum kaise control kar sakte hain"*), and
-- deferred rather than accepted.
--
-- The key is (incident, handset, the status it was offered AT). That is the natural bound:
--
--   * **Per incident**, because two emergencies are two conversations.
--   * **Per handset**, for `whatsapp_proactive`'s own reason — two officers on one emergency are
--     two people, and a key without the number would silence the second.
--   * **Per status**, so it re-arms when the emergency actually moves. Offered *Resolved* at
--     `responding` and the officer types again: nothing more is sent, because nothing has
--     changed. The moment somebody marks it responded from somewhere else, the next reply may be
--     answered again — which is correct, because the question has changed.
--
-- ⚠️ THE ROW IS WRITTEN BEFORE THE SEND, exactly as 0033's is, and for the same reason: a row for
-- a message that then failed costs an officer one prompt they were not going to get anyway; a
-- send recorded afterwards and interrupted by a restart is the same prompt on every reply.
--
-- ⚠️ AND IT CANNOT REFUSE. There is no RAISE and no EXCEPTION here — O-40's rule, paid for by
-- migration 0031 taking the district's service down for 34 minutes. A guard whose only way of
-- speaking is to kill the service is not a guard.

BEGIN;

CREATE TABLE IF NOT EXISTS whatsapp_stage_offer (
    -- The emergency the buttons were about. Not a foreign key to anything: `incident_event` is
    -- the record and this is a claim about what this software has already said to a handset —
    -- the same argument 0033 makes for itself.
    incident_id uuid        NOT NULL,

    -- Which handset. In E.164, as everything in `whatsapp_*` is — the roster's own `03xx` form
    -- would look here and find nothing, which is a lookup that fails silently.
    phone       text        NOT NULL,

    -- The incident's status at the moment the offer went. A text column rather than an enum,
    -- because `IncidentStatus` is folded in TypeScript and a second definition in the database is
    -- a second thing to keep in step — and this column is never compared to anything but itself.
    at_status   text        NOT NULL,

    -- When this system decided to offer. Deliberately not when Meta accepted it; the row is
    -- written first, so it cannot claim delivery.
    offered_at  timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (incident_id, phone, at_status)
);

INSERT INTO schema_migration (version) VALUES ('0034_whatsapp_stage_offer')
ON CONFLICT (version) DO NOTHING;

COMMIT;
