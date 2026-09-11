-- Inboxes live until expires_at (epoch ms). The cron job deletes expired rows.
CREATE TABLE inboxes (
  id TEXT PRIMARY KEY,
  local_part TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('web', 'agent')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX inboxes_expires_at ON inboxes (expires_at);

-- seq is the cursor for "messages after N". id is the public message ID.
CREATE TABLE messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  inbox_id TEXT NOT NULL REFERENCES inboxes (id) ON DELETE CASCADE,
  via TEXT NOT NULL CHECK (via IN ('smtp', 'sample', 'test')),
  received_at INTEGER NOT NULL,
  envelope_from TEXT NOT NULL,
  from_name TEXT,
  from_address TEXT,
  to_header TEXT,
  subject TEXT NOT NULL,
  snippet TEXT NOT NULL,
  text_body TEXT,
  html_body TEXT,
  truncated INTEGER NOT NULL DEFAULT 0,
  raw_size INTEGER NOT NULL,
  message_id TEXT,
  date_header TEXT,
  codes TEXT NOT NULL DEFAULT '[]',
  links TEXT NOT NULL DEFAULT '[]',
  attachments TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX messages_inbox_seq ON messages (inbox_id, seq);
