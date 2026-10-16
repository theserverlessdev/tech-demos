ALTER TABLE apps ADD COLUMN client_secret_hash TEXT;
ALTER TABLE apps ADD COLUMN client_secret_salt TEXT;
ALTER TABLE apps ADD COLUMN token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none';
ALTER TABLE apps ADD COLUMN grant_types TEXT NOT NULL DEFAULT '["authorization_code","refresh_token"]';
ALTER TABLE apps ADD COLUMN scopes TEXT NOT NULL DEFAULT 'openid profile email offline_access';
ALTER TABLE apps ADD COLUMN jwks TEXT;
ALTER TABLE apps ADD COLUMN client_type TEXT NOT NULL DEFAULT 'public';
ALTER TABLE apps ADD COLUMN resources TEXT;
ALTER TABLE apps ADD COLUMN registration_access_hash TEXT;
ALTER TABLE apps ADD COLUMN expires_at INTEGER;
ALTER TABLE apps ADD COLUMN require_pkce INTEGER NOT NULL DEFAULT 1;
ALTER TABLE apps ADD COLUMN response_types TEXT NOT NULL DEFAULT '["code"]';

ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE auth_codes ADD COLUMN resource TEXT;
ALTER TABLE auth_codes ADD COLUMN auth_time INTEGER;

CREATE TABLE IF NOT EXISTS consents (
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, client_id),
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS device_grants (
  id TEXT PRIMARY KEY,
  device_code_hash TEXT NOT NULL UNIQUE,
  user_code TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  audience TEXT,
  expires_at INTEGER NOT NULL,
  interval_sec INTEGER NOT NULL,
  last_poll_at INTEGER,
  user_id TEXT,
  denied_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS device_grants_expires ON device_grants (expires_at);
CREATE INDEX IF NOT EXISTS device_grants_user_code ON device_grants (user_code);

CREATE TABLE IF NOT EXISTS par_requests (
  request_uri TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS par_requests_expires ON par_requests (expires_at);

CREATE TABLE IF NOT EXISTS revoked_jtis (
  jti TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS revoked_jtis_expires ON revoked_jtis (expires_at);

CREATE TABLE IF NOT EXISTS federated_identities (
  provider TEXT NOT NULL,
  provider_sub TEXT NOT NULL,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, provider_sub),
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
