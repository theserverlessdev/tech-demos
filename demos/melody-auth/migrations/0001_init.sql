CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS users_expires ON users (expires_at);

CREATE TABLE IF NOT EXISTS apps (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  nonce TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS auth_codes_hash ON auth_codes (code_hash);
CREATE INDEX IF NOT EXISTS auth_codes_expires ON auth_codes (expires_at);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  family_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  replaced_by TEXT,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS refresh_tokens_hash ON refresh_tokens (token_hash);
CREATE INDEX IF NOT EXISTS refresh_tokens_family ON refresh_tokens (family_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_expires ON refresh_tokens (expires_at);

INSERT OR IGNORE INTO apps (id, client_id, name, redirect_uris, created_at) VALUES
(
  'app_sample',
  'melody-sample',
  'Sample app',
  '["http://127.0.0.1:8788/","http://127.0.0.1:8788/callback","http://localhost:8788/","http://localhost:8788/callback","https://tech-demos.theserverless.dev/demos/melody-auth/","https://tech-demos.theserverless.dev/demos/melody-auth/callback","https://melody-auth.tech-demos.theserverless.dev/","https://melody-auth.tech-demos.theserverless.dev/callback"]',
  0
),
(
  'app_docs',
  'melody-docs',
  'Docs example',
  '["https://melody-auth.tech-demos.theserverless.dev/docs/callback"]',
  0
);
