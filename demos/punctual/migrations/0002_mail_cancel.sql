-- Grow: cancel + honest mail/reminder statuses. Recreate bookings so CHECK constraints match.
-- Drop child reminders first so D1 foreign keys do not block DROP bookings.

CREATE TABLE bookings_new (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  guest_name TEXT NOT NULL,
  guest_email TEXT NOT NULL,
  slot_start TEXT NOT NULL,
  slot_end TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('confirmed', 'cancelled')),
  reminder_status TEXT NOT NULL DEFAULT 'queued'
    CHECK (reminder_status IN ('queued', 'sent', 'skipped', 'failed')),
  mail_status TEXT NOT NULL DEFAULT 'skipped'
    CHECK (mail_status IN ('sent', 'skipped', 'failed'))
);

INSERT INTO bookings_new (
  id, host_id, guest_name, guest_email, slot_start, slot_end, created_at, status, reminder_status, mail_status
)
SELECT
  id, host_id, guest_name, guest_email, slot_start, slot_end, created_at,
  'confirmed',
  reminder_status,
  'skipped'
FROM bookings;

CREATE TABLE reminders_new (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
INSERT INTO reminders_new SELECT id, booking_id, kind, status, detail, created_at FROM reminders;

DROP TABLE reminders;
DROP TABLE bookings;
ALTER TABLE bookings_new RENAME TO bookings;
ALTER TABLE reminders_new RENAME TO reminders;

CREATE UNIQUE INDEX bookings_host_slot_live ON bookings (host_id, slot_start) WHERE status = 'confirmed';
CREATE INDEX bookings_created ON bookings (created_at DESC);
CREATE INDEX bookings_slot_start ON bookings (slot_start);
CREATE INDEX reminders_booking ON reminders (booking_id);
