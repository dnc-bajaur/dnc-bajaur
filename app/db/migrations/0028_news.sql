-- 0028 — headlines from outside the district (M9-59)
--
-- WHY A TABLE AND NOT A FETCH ON EVERY RENDER
--
-- The dashboard refreshes itself continuously, on a screen a control room leaves on all day.
-- Fetching Google on every render would put the district's own machine into somebody else's
-- rate limiter within an hour, and the first thing that fails when it does is the dashboard.
--
-- So the shape is the one `weather_reading` already established (migration 0015): a background
-- refresh writes here, the dashboard reads the newest row, and a FAILED FETCH CHANGES NOTHING.
-- The previous headlines stay exactly where they are, ageing visibly, and the panel says how old
-- they are. That is a true statement. A blank panel is not — it says nothing about whether the
-- district's line is down, and a wall screen that goes quiet when the line drops teaches a room
-- to stop looking at it (ADR-0013, and `domain/wall.ts`'s whole header).
--
-- WHY THE WHOLE LIST IS ONE JSONB ROW
--
-- Headlines are not the district's record. Nothing folds them, nothing is ever asked "which
-- headline was showing at 02:00", and no invariant depends on one. They are a cache of somebody
-- else's page, and modelling them as rows with ids would invite exactly the questions they cannot
-- answer. One row per fetch, kept in order, pruned to the last few.
--
-- WHAT IS DELIBERATELY NOT HERE
--
-- No link is stored for the reader to follow. The dashboard shows aggregates and nothing on it is
-- a thing to open (ADR-0013 §1) — that rule does not stop applying because the row came from
-- outside. A room reads this; it does not click it.

BEGIN;

CREATE TABLE IF NOT EXISTS news_fetch (
    fetch_id   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    -- When this system fetched it. NOT when the story was published — each item carries its own
    -- published time inside the payload, and the two are different facts.
    fetched_at timestamptz NOT NULL DEFAULT now(),
    -- Where it came from, in words, so the panel can name its source on screen. A headline whose
    -- origin is not stated is a headline a room will attribute to the district itself.
    source     text        NOT NULL,
    payload    jsonb       NOT NULL
);

CREATE INDEX IF NOT EXISTS news_fetch_recent ON news_fetch (fetched_at DESC);

INSERT INTO schema_migration (version) VALUES ('0028_news')
ON CONFLICT (version) DO NOTHING;

COMMIT;
