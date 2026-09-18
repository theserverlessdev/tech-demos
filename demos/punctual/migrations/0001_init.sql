-- Double-book guarantee lives here: one row per host + slot start.
CREATE TABLE slot_locks (
  host_id TEXT NOT NULL,
  slot_start TEXT NOT NULL,
  booking_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (host_id, slot_start)
);

CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  guest_name TEXT NOT NULL,
  guest_email TEXT NOT NULL,
  slot_start TEXT NOT NULL,
  slot_end TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  reminder_status TEXT NOT NULL DEFAULT 'queued'
    CHECK (reminder_status IN ('queued', 'sent', 'failed'))
);

CREATE UNIQUE INDEX bookings_host_slot ON bookings (host_id, slot_start);
CREATE INDEX bookings_created ON bookings (created_at DESC);

CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings (id),
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX reminders_booking ON reminders (booking_id);
