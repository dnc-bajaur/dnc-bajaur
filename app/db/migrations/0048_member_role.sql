-- 0048 — the `member` role (ADR-0038, Bajaur).
--
-- A fifth role for officers who sign in for Activities only. The four existing roles are
-- unchanged. Enforcement is not here: the server refuses a member on every operational route
-- (`api/server.ts`, the gated `resolveSession`). This only lets the column hold the value.

BEGIN;

ALTER TABLE person DROP CONSTRAINT IF EXISTS person_role_check;

ALTER TABLE person
    ADD CONSTRAINT person_role_check
    CHECK (role IN ('owner', 'admin', 'operator', 'viewer', 'member'));

INSERT INTO schema_migration (version) VALUES ('0048_member_role')
ON CONFLICT (version) DO NOTHING;

COMMIT;
