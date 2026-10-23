CREATE TABLE drives (
  id TEXT PRIMARY KEY,
  email_hmac TEXT NOT NULL,
  email_enc TEXT NOT NULL,
  ip_hmac TEXT NOT NULL,
  network_hmac TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  wiped_at INTEGER,
  frozen_at INTEGER,
  status TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  session_hash TEXT,
  bytes_used INTEGER NOT NULL,
  file_count INTEGER NOT NULL,
  aup_version TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_one_live_email ON drives(email_hmac) WHERE status != 'wiped';
CREATE INDEX idx_drives_session ON drives(session_hash);
CREATE INDEX idx_drives_expires ON drives(expires_at);

CREATE TABLE verifications (
  token_hash TEXT PRIMARY KEY,
  email_hmac TEXT NOT NULL,
  email_enc TEXT NOT NULL,
  ip_hmac TEXT NOT NULL,
  network_hmac TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  aup_version TEXT NOT NULL,
  dev_token TEXT
);

CREATE TABLE objects (
  drive_id TEXT NOT NULL,
  key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  first_seen INTEGER NOT NULL,
  PRIMARY KEY (drive_id, key, sha256)
);

CREATE TABLE blocks (
  kind TEXT NOT NULL,
  hmac TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (kind, hmac)
);

CREATE TABLE reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  drive_id TEXT,
  reason TEXT NOT NULL,
  contact_enc TEXT,
  ip_hmac TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE mint_daily (
  day TEXT PRIMARY KEY,
  count INTEGER NOT NULL
);
