CREATE TABLE visitors (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  ip_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX drafts_day ON drafts (day);
CREATE INDEX drafts_day_ip ON drafts (day, ip_key);

ALTER TABLE tickets ADD COLUMN visitor_id TEXT;
CREATE INDEX tickets_visitor ON tickets (visitor_id, updated_at DESC);

ALTER TABLE attachments ADD COLUMN visitor_id TEXT;
CREATE INDEX attachments_visitor ON attachments (ticket_id, visitor_id);
