-- 0043 — a group member is a post or a person, never a `department` (ADR-0031, phase 2).
--
-- `RecipientKind` lost `'department'` in this phase: ADR-0023 stopped the picker offering one,
-- ADR-0029 removed the layer and ADR-0030 (migration 0039) dropped the table it named. A
-- `recipient_group_member` row with `kind = 'department'` has resolved to nothing since 0039 —
-- `db/groupStore.ts` no longer even looks one up. This tightens the CHECK to match the type.
--
-- ⚠️ NO GUARD, NO `RAISE`, NO `EXCEPTION` — O-40's lesson. It cannot refuse at boot: legacy
-- department members are DELETED (they name nothing), then the constraint is narrowed. On this
-- installation the record was rebuilt with zero department data, so the DELETE touches 0 rows.
-- `recipient_group_member` carries no append-only trigger (it is mutable config, edited by
-- `saveGroup`/`retireGroup`), so a DELETE here rewrites no protected history.

BEGIN;

DELETE FROM recipient_group_member WHERE kind = 'department';

ALTER TABLE recipient_group_member
    DROP CONSTRAINT IF EXISTS recipient_group_member_kind_check;

ALTER TABLE recipient_group_member
    ADD CONSTRAINT recipient_group_member_kind_check CHECK (kind IN ('post', 'person'));

INSERT INTO schema_migration (version) VALUES ('0043_group_member_no_department')
ON CONFLICT (version) DO NOTHING;

COMMIT;
