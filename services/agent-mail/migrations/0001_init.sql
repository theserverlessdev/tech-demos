-- Agent Mail. Mail rows stay until a spam TTL cleanup. Users are invite-only.

CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  global_kill INTEGER NOT NULL DEFAULT 0,
  unknown_policy TEXT NOT NULL DEFAULT 'reject' CHECK (unknown_policy IN ('reject', 'quarantine')),
  spam_ttl_days INTEGER NOT NULL DEFAULT 30
);
INSERT INTO settings (id) VALUES (1);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  display_name TEXT,
  invited_by TEXT,
  created_at INTEGER NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users (id),
  name TEXT NOT NULL,
  policy TEXT NOT NULL DEFAULT 'draft' CHECK (policy IN ('auto', 'draft', 'reply_only_auto')),
  daily_send_cap INTEGER NOT NULL DEFAULT 50,
  kill_switch INTEGER NOT NULL DEFAULT 0,
  webhook_url TEXT,
  webhook_secret_enc TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX agents_owner ON agents (owner_user_id);

CREATE TABLE inboxes (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents (id),
  local_part TEXT NOT NULL UNIQUE,
  display_name TEXT,
  policy_override TEXT CHECK (policy_override IN ('auto', 'draft', 'reply_only_auto')),
  daily_send_cap INTEGER,
  list_mode TEXT NOT NULL DEFAULT 'none' CHECK (list_mode IN ('none', 'allow', 'block')),
  allowlist TEXT NOT NULL DEFAULT '[]',
  blocklist TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at INTEGER NOT NULL
);
CREATE INDEX inboxes_agent ON inboxes (agent_id);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents (id),
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_hint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX api_keys_agent ON api_keys (agent_id);

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  inbox_id TEXT NOT NULL REFERENCES inboxes (id),
  subject TEXT NOT NULL,
  started_by TEXT NOT NULL CHECK (started_by IN ('external', 'agent', 'owner')),
  last_message_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX threads_inbox ON threads (inbox_id, last_message_at);

CREATE TABLE messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  thread_id TEXT NOT NULL REFERENCES threads (id),
  inbox_id TEXT NOT NULL REFERENCES inboxes (id),
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  via TEXT NOT NULL CHECK (via IN ('smtp', 'api', 'panel')),
  received_at INTEGER NOT NULL,
  envelope_from TEXT,
  from_name TEXT,
  from_address TEXT,
  to_addrs TEXT NOT NULL DEFAULT '[]',
  cc_addrs TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL,
  snippet TEXT NOT NULL DEFAULT '',
  text_body TEXT,
  html_body TEXT,
  truncated INTEGER NOT NULL DEFAULT 0,
  raw_size INTEGER NOT NULL DEFAULT 0,
  raw_r2_key TEXT,
  message_id TEXT,
  in_reply_to TEXT,
  references_header TEXT,
  date_header TEXT,
  spam INTEGER NOT NULL DEFAULT 0,
  attachments TEXT NOT NULL DEFAULT '[]',
  provider_message_id TEXT
);
CREATE INDEX messages_inbox_seq ON messages (inbox_id, seq);
CREATE INDEX messages_thread ON messages (thread_id, seq);
CREATE INDEX messages_msgid ON messages (inbox_id, message_id);
CREATE INDEX messages_spam ON messages (spam, received_at);

CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents (id),
  inbox_id TEXT NOT NULL REFERENCES inboxes (id),
  thread_id TEXT REFERENCES threads (id),
  reply_to_message_id TEXT,
  to_addrs TEXT NOT NULL,
  cc_addrs TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL,
  text_body TEXT,
  html_body TEXT,
  original_subject TEXT NOT NULL,
  original_text TEXT,
  original_html TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'rejected')),
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL CHECK (created_by IN ('agent', 'owner')),
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT,
  decision_note TEXT,
  sent_message_id TEXT
);
CREATE INDEX drafts_status ON drafts (status, created_at);
CREATE INDEX drafts_agent ON drafts (agent_id, status);

CREATE TABLE send_counters (
  scope TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, day)
);

CREATE TABLE quarantine (
  id TEXT PRIMARY KEY,
  local_part TEXT NOT NULL,
  envelope_from TEXT NOT NULL,
  subject TEXT,
  raw_r2_key TEXT NOT NULL,
  spam INTEGER NOT NULL DEFAULT 0,
  received_at INTEGER NOT NULL
);
CREATE INDEX quarantine_received ON quarantine (spam, received_at);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_at ON audit_log (at DESC);
