-- Google Calendar connect: encrypted host tokens + event id on bookings.

ALTER TABLE bookings ADD COLUMN google_event_id TEXT;
ALTER TABLE bookings ADD COLUMN google_status TEXT NOT NULL DEFAULT 'skipped';

CREATE TABLE host_google (
  host_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  token_expires_at INTEGER NOT NULL,
  scopes TEXT,
  updated_at INTEGER NOT NULL
);
