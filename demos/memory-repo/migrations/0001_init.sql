CREATE TABLE IF NOT EXISTS visitors (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  repo_name TEXT NOT NULL UNIQUE,
  remote TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS visitors_expires ON visitors (expires_at);
