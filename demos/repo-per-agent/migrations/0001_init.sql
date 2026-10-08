CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  visitor_id TEXT NOT NULL,
  repo_name TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  remote TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS tasks_visitor ON tasks (visitor_id, expires_at);
CREATE INDEX IF NOT EXISTS tasks_expires ON tasks (expires_at);

CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  commit_hash TEXT,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS activity_task ON activity (task_id, created_at);
