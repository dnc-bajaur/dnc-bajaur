-- 0049 — an account's post, as text (ADR-0038 §5, Bajaur).
--
-- "Add account" asks for Name, Post and Phone. The post of a *contact* lives on its seat; an
-- account made in Settings has no seat, so its post is kept here. Display only: authority is
-- `person.role` and never this text (ADR-0029 §2). Nullable — every existing account has none.

BEGIN;

ALTER TABLE person ADD COLUMN IF NOT EXISTS designation text;

INSERT INTO schema_migration (version) VALUES ('0049_person_designation')
ON CONFLICT (version) DO NOTHING;

COMMIT;
