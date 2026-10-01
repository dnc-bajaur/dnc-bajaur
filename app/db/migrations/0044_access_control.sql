-- 0044 — access control: roles, per-account overrides, and an access history (ADR-0032).
--
-- Every account that can sign in today is all-powerful: `identity.isAdministration` is one
-- boolean ticked on a seat, gating the whole Administration console through one function. The
-- owner asked for the account model brought to industry standard — one true administrator,
-- graded non-admin accounts, per-account restriction, self-service password change, and an
-- access log. ADR-0032 is the decision. This migration is its foundation.
--
-- Three things:
--   * `person` gains a role, and the three lifecycle timestamps a real account model needs.
--   * `access_event` — append-only, the same argument as `config_event` (0007) applied to
--     accounts: "why could that officer still sign in?" is a question a current-state table
--     cannot answer.
--   * `person_permission` — current state, like `sla_target`: the allow/deny overrides that
--     `resolvePermissions` folds on top of the role. `access_event` is its history.
--
-- ⚠️ NO GUARD, NO `RAISE`, NO `EXCEPTION`. O-40's lesson — a migration that can refuse runs at
-- boot and took Bajaur off the air for 34 minutes once. This one only adds columns and tables
-- and backfills; it cannot fail on the district's data. The one question worth refusing over —
-- is there exactly one administration account to make `owner`? — is answered by the backfill
-- picking deterministically and this comment stating it, not by a boot-time check. If more than
-- one administration account holds a login, the OLDEST becomes `owner` and the rest `admin`;
-- the owner reassigns from Settings.

BEGIN;

--------------------------------------------------------------------------------
-- 1. `person` gains a role and its lifecycle
--------------------------------------------------------------------------------
--
-- The role is an explicit column an administrator sets. It is NEVER derived from the
-- designation text (ADR-0029 §2) — a typo or an "AC HQ (acting)" must not move who may create
-- an account, silently, with nothing on any screen showing it.
--
--   owner    — the one super-administrator. Exactly one. Un-removable and un-demotable from
--              inside the app; handover is owner -> owner, demoting the previous holder.
--   admin    — everything owner does except touch the owner account or lower the policy floors.
--   operator — today's control-room account: full operational use, no account management.
--   viewer   — read-only.
ALTER TABLE person
    ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'operator'
        CHECK (role IN ('owner', 'admin', 'operator', 'viewer'));

-- Suspend an account without removing it — the holder keeps their history and can be
-- reactivated. Distinct from `disabled_at`, which the directory loader owns.
ALTER TABLE person ADD COLUMN IF NOT EXISTS suspended_at timestamptz;

-- Set when an administrator resets someone else's password. The holder cannot keep a password
-- an administrator has seen: sign-in lands them on "change my password" and will not leave.
ALTER TABLE person
    ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

-- `person.removed_at` ALREADY EXISTS (migration 0009) and is what `removePerson` sets. The
-- access model adopts it unchanged — removal is not a DELETE (ADR-0001: the record is not
-- rewritten), the account leaves every screen and sign-in is refused, and past incidents,
-- dispatches and access events still name the person. No column to add.

--------------------------------------------------------------------------------
-- 2. Backfill the roles from what exists today
--------------------------------------------------------------------------------
--
-- "Holds a login" = `password_hash IS NOT NULL` (directory contacts have no hash and cannot
-- sign in — sessions.ts filters on exactly this). "Administration account" = holds a current
-- seat carrying the administration tick.
--
-- The owner: the OLDEST such account, deterministically (created_at, then person_id). Everyone
-- else with an administration seat: admin. Everyone else who can sign in keeps the `operator`
-- default. A contact with no hash keeps `operator` too and it is inert — role is only ever
-- consulted for an authenticated session.

WITH admin_accounts AS (
    SELECT DISTINCT p.person_id, p.created_at
      FROM person p
      JOIN duty_assignment d ON d.person_id = p.person_id AND d.to_at IS NULL
      JOIN seat s            ON s.seat_id = d.seat_id
     WHERE p.password_hash IS NOT NULL
       AND p.removed_at IS NULL
       AND p.disabled_at IS NULL
       AND s.is_administration
),
the_owner AS (
    SELECT person_id
      FROM admin_accounts
     ORDER BY created_at ASC, person_id ASC
     LIMIT 1
)
UPDATE person p
   SET role = CASE
                WHEN p.person_id = (SELECT person_id FROM the_owner) THEN 'owner'
                ELSE 'admin'
              END
 WHERE p.person_id IN (SELECT person_id FROM admin_accounts);

--------------------------------------------------------------------------------
-- 3. `access_event` — the history, append-only
--------------------------------------------------------------------------------
--
-- Modelled on `config_event` (0007) and for the same reason: an incident review, weeks later,
-- asks "why could that officer still sign in?" and a table holding only the current role
-- cannot answer. Separate from `config_event` because these are not facts about a department
-- or a routing signal; they have a subject person, not a subject_id, and folding them in would
-- make every config projection skip rows.

CREATE TABLE IF NOT EXISTS access_event (
    event_id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    seq               bigserial   NOT NULL UNIQUE,

    type              text        NOT NULL,

    -- Who performed it. Null for a `login_failed` where no session exists, or a system act.
    actor_person_id   uuid        REFERENCES person(person_id),
    -- Whose account it concerns. Null for a `login_failed` against an unknown number.
    subject_person_id uuid        REFERENCES person(person_id),

    -- Whole before/after values, not a diff engine. e.g. { "role": "operator" } / { "role": "admin" }.
    before            jsonb,
    after             jsonb,

    -- Required for the destructive acts (see the CHECK). Free text otherwise.
    reason            text,

    recorded_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT access_event_type_known CHECK (type IN (
        'granted',            -- a login was created for a person
        'role_changed',
        'permission_set',     -- an allow/deny override was written
        'permission_cleared',
        'password_reset',     -- an administrator reset someone else's password
        'password_changed',   -- a person changed their own
        'suspended',
        'reactivated',
        'removed',
        'session_revoked',    -- force sign-out, or the cascade from a password change
        'login_succeeded',
        'login_failed'
    )),

    -- Taking an account away or freezing it is not a change anyone makes anonymously and
    -- without saying why (INV-06; config_event applies the same rule to `retired`). The rest
    -- is enforced at the API layer, where the UI collects a reason for every act.
    CONSTRAINT access_event_destructive_needs_reason
        CHECK (type NOT IN ('removed', 'suspended')
               OR (reason IS NOT NULL AND btrim(reason) <> ''))
);

CREATE INDEX IF NOT EXISTS access_event_by_subject
    ON access_event (subject_person_id, seq);
CREATE INDEX IF NOT EXISTS access_event_by_time
    ON access_event (recorded_at DESC);
CREATE INDEX IF NOT EXISTS access_event_by_type
    ON access_event (type, recorded_at DESC);

CREATE OR REPLACE FUNCTION access_event_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION
        'access_event is append-only; % is not permitted. Correct a mistake by appending a new event.',
        TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS access_event_no_update ON access_event;
CREATE TRIGGER access_event_no_update
    BEFORE UPDATE OR DELETE ON access_event
    FOR EACH ROW
    EXECUTE FUNCTION access_event_reject_mutation();

DROP TRIGGER IF EXISTS access_event_no_truncate ON access_event;
CREATE TRIGGER access_event_no_truncate
    BEFORE TRUNCATE ON access_event
    FOR EACH STATEMENT
    EXECUTE FUNCTION access_event_reject_mutation();

--------------------------------------------------------------------------------
-- 4. `person_permission` — the overrides, current state
--------------------------------------------------------------------------------
--
-- The allow/deny rows `resolvePermissions(role, overrides)` folds on top of the role's fixed
-- set — deny wins. This is how "restrict this operator from the roster" and "let this operator
-- reset passwords" are expressed without breeding half-roles.
--
-- No CHECK on `permission` against a value list: the enumeration lives in `domain/roles.ts`
-- and evolves, and a CHECK would need a migration every time (the same reasoning that keeps
-- capability strings out of a constraint). The API validates against `PERMISSIONS`.

CREATE TABLE IF NOT EXISTS person_permission (
    person_id        uuid        NOT NULL REFERENCES person(person_id),
    permission       text        NOT NULL CHECK (btrim(permission) <> ''),
    effect           text        NOT NULL CHECK (effect IN ('allow', 'deny')),
    set_at           timestamptz NOT NULL DEFAULT now(),
    set_by_person_id uuid        REFERENCES person(person_id),

    -- One effect per (person, permission). Setting allow after deny replaces it; the change
    -- is a `permission_set` row in access_event.
    PRIMARY KEY (person_id, permission)
);

CREATE INDEX IF NOT EXISTS person_permission_by_person
    ON person_permission (person_id);

INSERT INTO schema_migration (version) VALUES ('0044_access_control')
ON CONFLICT (version) DO NOTHING;

COMMIT;
