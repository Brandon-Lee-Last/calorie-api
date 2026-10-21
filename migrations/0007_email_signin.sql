-- Email one-time-code sign-in: lets a person recover their account without Google.

-- SQLite cannot change a CHECK constraint in place, so the table is rebuilt. Nothing references identities.
CREATE TABLE identities_new (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider   TEXT NOT NULL CHECK (provider IN ('google', 'email')),
  subject    TEXT NOT NULL,
  email      TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (provider, subject)
);
INSERT INTO identities_new SELECT id, user_id, provider, subject, email, created_at FROM identities;
DROP TABLE identities;
ALTER TABLE identities_new RENAME TO identities;
CREATE INDEX identities_user ON identities (user_id);
CREATE INDEX identities_email ON identities (email);

-- A pending sign-in code. Neither the address nor the code is stored, only keyed hashes of them.
CREATE TABLE email_codes (
  id          TEXT PRIMARY KEY,
  email_hash  TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX email_codes_lookup ON email_codes (email_hash, created_at);
CREATE INDEX email_codes_expiry ON email_codes (expires_at);
