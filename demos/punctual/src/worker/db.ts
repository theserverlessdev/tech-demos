import type { Booking, BookingStatus, MailStatus, ReminderStatus } from "../shared/types";

type BookingRow = {
  id: string;
  host_id: string;
  guest_name: string;
  guest_email: string;
  slot_start: string;
  slot_end: string;
  created_at: number;
  status: BookingStatus;
  reminder_status: ReminderStatus;
  mail_status: MailStatus;
  google_event_id?: string | null;
  google_status?: MailStatus | null;
};

export type HostGoogleRow = {
  host_id: string;
  email: string;
  access_token_enc: string;
  refresh_token_enc: string;
  token_expires_at: number;
  scopes: string | null;
  updated_at: number;
};

export function toBooking(row: BookingRow): Booking {
  return {
    id: row.id,
    hostId: row.host_id,
    guestName: row.guest_name,
    guestEmail: row.guest_email,
    slotStart: row.slot_start,
    slotEnd: row.slot_end,
    createdAt: row.created_at,
    status: row.status,
    reminderStatus: row.reminder_status,
    mailStatus: row.mail_status,
    googleEventId: row.google_event_id ?? null,
    googleStatus: row.google_status ?? "skipped",
  };
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

export async function listTakenStarts(db: D1Database, hostId: string): Promise<Set<string>> {
  const rows = await db
    .prepare("SELECT slot_start FROM slot_locks WHERE host_id = ?")
    .bind(hostId)
    .all<{ slot_start: string }>();
  return new Set((rows.results ?? []).map((row) => row.slot_start));
}

export async function getBooking(db: D1Database, id: string): Promise<Booking | null> {
  const row = await db.prepare("SELECT * FROM bookings WHERE id = ?").bind(id).first<BookingRow>();
  return row ? toBooking(row) : null;
}

export async function countBookings(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE status = 'confirmed'").first<{ n: number }>();
  return row?.n ?? 0;
}

export async function countReminders(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM reminders").first<{ n: number }>();
  return row?.n ?? 0;
}

export async function listUpcoming(db: D1Database, hostId: string, nowIso: string): Promise<Booking[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM bookings
       WHERE host_id = ? AND status = 'confirmed' AND slot_start >= ?
       ORDER BY slot_start ASC
       LIMIT 100`,
    )
    .bind(hostId, nowIso)
    .all<BookingRow>();
  return (rows.results ?? []).map(toBooking);
}

export function isUniqueError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(message);
}

export async function insertBooking(
  db: D1Database,
  booking: {
    id: string;
    hostId: string;
    guestName: string;
    guestEmail: string;
    slotStart: string;
    slotEnd: string;
    now: number;
  },
): Promise<void> {
  await db.batch([
    db
      .prepare("INSERT INTO slot_locks (host_id, slot_start, booking_id, created_at) VALUES (?, ?, ?, ?)")
      .bind(booking.hostId, booking.slotStart, booking.id, booking.now),
    db
      .prepare(
        `INSERT INTO bookings (id, host_id, guest_name, guest_email, slot_start, slot_end, created_at, status, reminder_status, mail_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', 'queued', 'skipped')`,
      )
      .bind(
        booking.id,
        booking.hostId,
        booking.guestName,
        booking.guestEmail,
        booking.slotStart,
        booking.slotEnd,
        booking.now,
      ),
  ]);
}

export async function setMailStatus(db: D1Database, bookingId: string, status: MailStatus): Promise<void> {
  await db.prepare("UPDATE bookings SET mail_status = ? WHERE id = ?").bind(status, bookingId).run();
}

export async function setReminderStatus(
  db: D1Database,
  bookingId: string,
  status: ReminderStatus,
  detail: string,
  now: number,
): Promise<void> {
  await db.batch([
    db
      .prepare("INSERT INTO reminders (id, booking_id, kind, status, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(newId("rem"), bookingId, "reminder", status, detail, now),
    db.prepare("UPDATE bookings SET reminder_status = ? WHERE id = ?").bind(status, bookingId),
  ]);
}

export async function cancelBooking(db: D1Database, booking: Booking, now: number): Promise<boolean> {
  if (booking.status === "cancelled") return false;
  await db.batch([
    db.prepare("DELETE FROM slot_locks WHERE booking_id = ?").bind(booking.id),
    db
      .prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ? AND status = 'confirmed'")
      .bind(booking.id),
    db
      .prepare("UPDATE bookings SET reminder_status = 'skipped' WHERE id = ? AND reminder_status = 'queued'")
      .bind(booking.id),
    db
      .prepare("INSERT INTO reminders (id, booking_id, kind, status, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(newId("rem"), booking.id, "cancel", "skipped", "Booking cancelled; slot unlocked.", now),
  ]);
  return true;
}

export async function setGoogleEvent(
  db: D1Database,
  bookingId: string,
  eventId: string | null,
  status: MailStatus,
): Promise<void> {
  await db
    .prepare("UPDATE bookings SET google_event_id = ?, google_status = ? WHERE id = ?")
    .bind(eventId, status, bookingId)
    .run();
}

export async function getHostGoogle(db: D1Database, hostId: string): Promise<HostGoogleRow | null> {
  return db.prepare("SELECT * FROM host_google WHERE host_id = ?").bind(hostId).first<HostGoogleRow>();
}

export async function upsertHostGoogle(
  db: D1Database,
  row: {
    hostId: string;
    email: string;
    accessTokenEnc: string;
    refreshTokenEnc: string;
    tokenExpiresAt: number;
    scopes: string;
    now: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO host_google (host_id, email, access_token_enc, refresh_token_enc, token_expires_at, scopes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(host_id) DO UPDATE SET
         email = excluded.email,
         access_token_enc = excluded.access_token_enc,
         refresh_token_enc = excluded.refresh_token_enc,
         token_expires_at = excluded.token_expires_at,
         scopes = excluded.scopes,
         updated_at = excluded.updated_at`,
    )
    .bind(row.hostId, row.email, row.accessTokenEnc, row.refreshTokenEnc, row.tokenExpiresAt, row.scopes, row.now)
    .run();
}

export async function updateHostGoogleAccess(
  db: D1Database,
  hostId: string,
  accessTokenEnc: string,
  tokenExpiresAt: number,
  now: number,
): Promise<void> {
  await db
    .prepare("UPDATE host_google SET access_token_enc = ?, token_expires_at = ?, updated_at = ? WHERE host_id = ?")
    .bind(accessTokenEnc, tokenExpiresAt, now, hostId)
    .run();
}

export async function deleteHostGoogle(db: D1Database, hostId: string): Promise<void> {
  await db.prepare("DELETE FROM host_google WHERE host_id = ?").bind(hostId).run();
}

export async function isGoogleConnected(db: D1Database, hostId: string): Promise<boolean> {
  const row = await db.prepare("SELECT host_id FROM host_google WHERE host_id = ?").bind(hostId).first<{ host_id: string }>();
  return Boolean(row);
}
