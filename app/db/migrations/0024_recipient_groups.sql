-- 0024 — groups: the sets of people the control room tells together (M7-09…M7-14, ADR-0018).
--
-- "Flood on the river", "Tehsil Mamund emergency", "the road-accident six". An operator ticking
-- the same six departments forty times a month is an operator who will one night tick five.
--
--------------------------------------------------------------------------------
-- One scope, and it is the control room's
--------------------------------------------------------------------------------
--
-- There is no owning department on these rows and no per-department scope, because under
-- ADR-0018 there are no department users. Adding an owner column "for later" would be a column
-- every query has to filter on, forever, to express a distinction nothing in the product makes.
-- When departments come back — if they do — that is a migration, and it will be written by
-- somebody who knows what the distinction actually turned out to be.
--
--------------------------------------------------------------------------------
-- Why members are rows and not jsonb
--------------------------------------------------------------------------------
--
-- The dashboard layout (0022) and the capability set (0023) are both jsonb, and they are right
-- to be: nothing else in the database refers to a panel. A group's members **are** departments,
-- seats and people — rows that get retired, and posts that get abolished. As jsonb they would
-- rot silently, and the first anybody would know is a flood alert going to five of six.
--
-- As rows they cannot: `ON DELETE CASCADE` is deliberately **not** used, because a member
-- vanishing without trace is the failure this table exists to prevent. Retirement is soft
-- everywhere in this schema (`retired_at`, `removed_at`), so a retired member stays joinable and
-- the group screen can say *"this post no longer exists"* — which is a thing to act on, where a
-- silently shorter list is a thing to discover.
--
--------------------------------------------------------------------------------
-- What this table is NOT
--------------------------------------------------------------------------------
--
-- **Not a reference an incident holds.** A group is expanded at dispatch time and the members
-- are written into the `dispatched` event (M7-10). If a group changes next month, last month's
-- incident must still say who was actually told — an incident that reads its recipients through
-- a live group is an incident whose own history changes when somebody edits a setting, which is
-- exactly what ADR-0001 exists to prevent.
--
-- **Not an authority boundary.** Membership decides who gets pre-ticked. It decides nothing
-- about what anybody may do (INV-05).

BEGIN;

CREATE TABLE IF NOT EXISTS recipient_group (
    group_id    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    -- Soft, like every other retirement here. A group named on an old `dispatched` event must
    -- keep resolving to a name, or six months of history becomes a column of uuids.
    retired_at  timestamptz
);

-- Unique among the groups that still exist. A retired "Flood" and a new "Flood" is an ordinary
-- thing for a district to do across two seasons; two live ones is a typo an operator will pick
-- the wrong one of at 02:00.
CREATE UNIQUE INDEX IF NOT EXISTS recipient_group_live_name
    ON recipient_group (lower(name)) WHERE retired_at IS NULL;

CREATE TABLE IF NOT EXISTS recipient_group_member (
    group_id      uuid    NOT NULL REFERENCES recipient_group (group_id),
    -- The same three the control room can tell anywhere else (`RecipientKind`). Kept as text
    -- plus a check rather than as three nullable foreign keys, because the alternative is a
    -- table where two of every three columns are null and every read has to coalesce them.
    kind          text    NOT NULL CHECK (kind IN ('department', 'post', 'person')),
    member_id     uuid    NOT NULL,
    -- The order the district put them in. Ordered because a group is read aloud on a telephone
    -- and *"Rescue, then Police, then the AC"* is how the control room thinks about it — an
    -- alphabetical list is a different sentence.
    position      integer NOT NULL,
    PRIMARY KEY (group_id, kind, member_id)
);

CREATE INDEX IF NOT EXISTS recipient_group_member_order
    ON recipient_group_member (group_id, position);

ALTER TABLE config_event DROP CONSTRAINT IF EXISTS config_event_subject_known;
ALTER TABLE config_event
    ADD CONSTRAINT config_event_subject_known
    CHECK (subject IN ('department', 'routing_signal', 'sla_target', 'seat', 'person', 'duty',
                       'resource', 'channel_ladder', 'utility', 'wall_screen',
                       'district_fact', 'district_alert', 'dashboard_layout', 'capability',
                       'recipient_group'));

-- No rows. A district with no groups is the normal starting state and the console says so; a
-- set of guessed ones would be a placeholder that does not look like a placeholder.

INSERT INTO schema_migration (version) VALUES ('0024_recipient_groups')
ON CONFLICT (version) DO NOTHING;

COMMIT;
