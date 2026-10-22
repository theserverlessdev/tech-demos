ALTER TABLE refresh_tokens ADD COLUMN resource TEXT;
ALTER TABLE refresh_tokens ADD COLUMN auth_time INTEGER;
ALTER TABLE apps ADD COLUMN post_logout_redirect_uris TEXT;

CREATE TABLE IF NOT EXISTS fed_states (
  state TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS fed_states_expires ON fed_states (expires_at);
