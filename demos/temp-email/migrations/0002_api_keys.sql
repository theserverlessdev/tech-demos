-- Per-agent API keys. The plaintext key is returned once at mint; we store SHA-256.
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0,
  inbox_limit INTEGER NOT NULL DEFAULT 10,
  create_limit INTEGER NOT NULL DEFAULT 40,
  window_start INTEGER NOT NULL,
  window_creates INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX api_keys_hash ON api_keys (key_hash);
CREATE INDEX api_keys_revoked_created ON api_keys (revoked, created_at);

-- Minted keys own the inboxes they create. Web and admin inboxes keep NULL.
ALTER TABLE inboxes ADD COLUMN api_key_id TEXT REFERENCES api_keys (id);
CREATE INDEX inboxes_api_key ON inboxes (api_key_id, expires_at);
