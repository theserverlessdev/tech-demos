-- Anonymous audit log. No IP addresses, no raw email bodies.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  tool TEXT NOT NULL,
  args_summary TEXT NOT NULL,
  decision TEXT NOT NULL,
  probabilities TEXT NOT NULL,
  confidence REAL NOT NULL,
  latency_ms INTEGER NOT NULL,
  model TEXT NOT NULL,
  source TEXT NOT NULL,
  human_outcome TEXT,
  resolved_at INTEGER
);

CREATE INDEX idx_decisions_session ON decisions (session_id, created_at);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);
CREATE INDEX idx_decisions_created ON decisions (created_at);
