CREATE TABLE IF NOT EXISTS spend (
  ip_key TEXT NOT NULL,
  day TEXT NOT NULL,
  calls INTEGER NOT NULL,
  PRIMARY KEY (ip_key, day)
);

CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  visitor_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY,
  visitor_id TEXT NOT NULL,
  ip_key TEXT NOT NULL,
  sample_id TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  status TEXT NOT NULL,
  answers_json TEXT,
  corrections_json TEXT,
  source TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS inbox_visitor ON inbox (visitor_id, created_at DESC);
