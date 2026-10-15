CREATE TABLE media (
  id TEXT PRIMARY KEY,
  visitor_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  duration_ms INTEGER,
  r2_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_media_expires ON media (expires_at);

CREATE TABLE judgments (
  id TEXT PRIMARY KEY,
  visitor_id TEXT NOT NULL,
  media_id TEXT,
  sample_id TEXT,
  kind TEXT NOT NULL,
  modality TEXT NOT NULL,
  label TEXT NOT NULL,
  ip_key TEXT NOT NULL,
  questions_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT '',
  cost_usd REAL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_judgments_visitor ON judgments (visitor_id, created_at);
CREATE INDEX idx_judgments_ip ON judgments (ip_key, created_at);
CREATE INDEX idx_judgments_created ON judgments (created_at);
CREATE INDEX idx_judgments_expires ON judgments (expires_at);
