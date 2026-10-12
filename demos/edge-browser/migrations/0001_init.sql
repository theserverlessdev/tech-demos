CREATE TABLE IF NOT EXISTS captures (
  id TEXT PRIMARY KEY,
  visitor_id TEXT NOT NULL,
  url TEXT NOT NULL,
  final_url TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  steps_json TEXT NOT NULL,
  error TEXT,
  browser_mode TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  session_note TEXT NOT NULL DEFAULT '',
  summary_source TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS captures_visitor_created ON captures (visitor_id, created_at);
CREATE INDEX IF NOT EXISTS captures_expires ON captures (expires_at);
