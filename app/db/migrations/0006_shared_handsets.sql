-- 0006 — a phone number identifies an account, not a person (Q-19).
--
-- The district's contact list gives 03000000171 to two officers: ADC (Finance & Planning)
-- and TMO Bajaur. The owner confirmed both are correct — an office handset covering two
-- posts is ordinary here, and refusing it would have meant carrying a directory that
-- disagrees with the district it describes.
--
-- But `phone` is also the login identifier, and "who is signing in?" must have exactly one
-- answer. Dropping uniqueness outright would make that ambiguous: `login()` picks a row by
-- phone, and with two candidates it would pick arbitrarily.
--
-- So uniqueness moves to where it is actually load-bearing. A person who can authenticate
-- (`password_hash IS NOT NULL`) must own their number. A directory contact — notifiable,
-- no credentials, see migration 0005 — may share one.
--
-- The consequence worth stating: **giving an account to someone who shares a handset with
-- an existing account will now fail**, loudly, at the point of granting it. That is the
-- correct moment to discover it and the correct person to be told.

BEGIN;

ALTER TABLE person DROP CONSTRAINT IF EXISTS person_phone_key;

CREATE UNIQUE INDEX IF NOT EXISTS person_phone_account_unique
    ON person (phone)
    WHERE password_hash IS NOT NULL;

-- Still the lookup path for login and for the directory loader.
CREATE INDEX IF NOT EXISTS person_by_phone ON person (phone);

INSERT INTO schema_migration (version) VALUES ('0006_shared_handsets')
ON CONFLICT (version) DO NOTHING;

COMMIT;
