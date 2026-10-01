-- 0013 — the notification ladder, as configuration (M3-01, ADR-0012).
--
-- The owner's answer to Q-07 was an order, not a channel:
--
--   > WhatsApp is first priority. If WhatsApp is not reachable, it should redirect to a
--   > direct call on the phone network. And the user should be able to choose to route a
--   > notification to another channel when they need to.
--
-- So the thing being stored is a **sequence**, and it is data rather than code for the same
-- reason the authority rules are (ADR-0003): the district changes it when a provider fails
-- them at 02:00, and that must not require a release.
--
--------------------------------------------------------------------------------
-- Why rows rather than a column
--------------------------------------------------------------------------------
--
-- An ordered list in a text column would need parsing, could hold a channel that does not
-- exist, and could not carry a per-rung note. One row per rung means the database enforces
-- what a rung is, and `position` makes the order explicit rather than implied by insertion.
--
-- `seat_id IS NULL` is the district default, exactly as `sla_target` does it — and for the
-- same reason: Rescue's night duty officer may want a call first while an office post is
-- fine with a message, and neither should have to be special-cased in code.

BEGIN;

CREATE TABLE IF NOT EXISTS channel_ladder (
    rung_id    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- NULL means the district-wide default: what every seat gets unless it says otherwise.
    seat_id    uuid        REFERENCES seat(seat_id),

    /**
     * Which way of reaching somebody.
     *
     * `web` is deliberately **not** in this list. The in-app inbox is not a rung — it always
     * happens, in parallel, and it costs nothing. Putting it in the ladder would let a
     * district configure a seat whose only notification is one nobody looks at.
     */
    channel    text        NOT NULL CHECK (channel IN ('whatsapp', 'voice', 'sms', 'gsm_sms', 'gsm_voice')),

    -- 1 is tried first. Contiguity is not enforced: an administrator removing a rung should
    -- not have to renumber the rest, and gaps change nothing about the order.
    position   integer     NOT NULL CHECK (position > 0),

    updated_at timestamptz NOT NULL DEFAULT now()
);

-- One rung per channel per ladder, and one channel per position. Both directions matter:
-- the same channel twice would notify somebody twice, and two channels at one position
-- would make "what is tried first" unanswerable.
CREATE UNIQUE INDEX IF NOT EXISTS channel_ladder_seat_channel
    ON channel_ladder (seat_id, channel) WHERE seat_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS channel_ladder_district_channel
    ON channel_ladder (channel) WHERE seat_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS channel_ladder_seat_position
    ON channel_ladder (seat_id, position) WHERE seat_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS channel_ladder_district_position
    ON channel_ladder (position) WHERE seat_id IS NULL;

--------------------------------------------------------------------------------
-- The district default, from the owner's own words
--------------------------------------------------------------------------------
--
-- WhatsApp, then a voice call, then SMS — and then the two GSM rungs, which are the only
-- ones that survive the district's internet going down (ADR-0012). They sit last because
-- they cost money per message and need hardware in the DC office; they are in the ladder
-- from the start so that the day the line drops, the configuration already says what to do
-- rather than somebody having to think of it.
--
-- None of these can send anything yet. Every provider is unconfigured until R-05, and an
-- unconfigured provider **fails loudly** rather than quietly reporting success — see
-- `src/channels/`.
INSERT INTO channel_ladder (seat_id, channel, position)
VALUES (NULL, 'whatsapp',  1),
       (NULL, 'voice',     2),
       (NULL, 'sms',       3),
       (NULL, 'gsm_sms',   4),
       (NULL, 'gsm_voice', 5)
ON CONFLICT DO NOTHING;

--------------------------------------------------------------------------------
-- Which channel an attempt used
--------------------------------------------------------------------------------
--
-- `notified` already records a channel, and its type was the four `SourceChannel` values —
-- `web`, `sms`, `call` and so on — which cannot express "WhatsApp" or "SMS through the modem
-- in the DC office rather than through the gateway". Those are different failures with
-- different fixes, and a ledger that cannot tell them apart cannot answer *why did nobody
-- get this*.
--
-- Nothing in the database constrains the payload, so this is a note rather than a migration
-- step: see `NotifyChannel` in `domain/events.ts`.

-- Reordering the ladder is a configuration change like any other, and the one somebody
-- will be asked about after a night when nobody was called.
ALTER TABLE config_event DROP CONSTRAINT IF EXISTS config_event_subject_known;
ALTER TABLE config_event
    ADD CONSTRAINT config_event_subject_known
    CHECK (subject IN ('department', 'routing_signal', 'sla_target', 'seat', 'person', 'duty',
                       'resource', 'channel_ladder'));

INSERT INTO schema_migration (version) VALUES ('0013_channel_ladder')
ON CONFLICT (version) DO NOTHING;

COMMIT;
