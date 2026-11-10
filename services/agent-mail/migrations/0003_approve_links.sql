-- One-tap approval links. The raw token is never stored.
ALTER TABLE settings ADD COLUMN approve_links INTEGER NOT NULL DEFAULT 1;

CREATE TABLE approve_tokens (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES drafts (id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX approve_tokens_draft ON approve_tokens (draft_id);
