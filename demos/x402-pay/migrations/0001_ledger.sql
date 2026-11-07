-- Sessions, confirms, daily caps, and the payment ledger.
-- Rows are added. Nothing here drops or rewrites an existing table.

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE confirmations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  args_json TEXT NOT NULL,
  binding TEXT NOT NULL,
  network TEXT NOT NULL,
  asset TEXT NOT NULL,
  pay_to TEXT NOT NULL,
  amount TEXT NOT NULL,
  scheme TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  result_text TEXT,
  transaction_id TEXT,
  settlement TEXT,
  error_code TEXT
);

CREATE INDEX confirmations_session ON confirmations (session_id, created_at);

CREATE TABLE daily_counts (
  scope TEXT NOT NULL,
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (scope, day, kind)
);

CREATE TABLE timeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL
);

CREATE INDEX timeline_session ON timeline (session_id, id);

-- Hash of the payment token. The token and the signature are not stored.
CREATE TABLE fingerprints (
  fingerprint TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
