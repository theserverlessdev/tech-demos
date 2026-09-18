import type { Booking, ReminderStatus } from "../shared/types";

type BookingRow = {
  id: string;
  host_id: string;
  guest_name: string;
  guest_email: string;
  slot_start: string;
  slot_end: string;
  created_at: number;
  reminder_status: ReminderStatus;
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
    reminderStatus: row.reminder_status,
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
  const row = await db.prepare("SELECT COUNT(*) AS n FROM bookings").first<{ n: number }>();
  return row?.n ?? 0;
}

export async function countReminders(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM reminders").first<{ n: number }>();
  return row?.n ?? 0;
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
        `INSERT INTO bookings (id, host_id, guest_name, guest_email, slot_start, slot_end, created_at, reminder_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued')`,
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

export async function markReminderSent(
  db: D1Database,
  bookingId: string,
  detail: string,
  now: number,
): Promise<void> {
  await db.batch([
    db
      .prepare("INSERT INTO reminders (id, booking_id, kind, status, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(newId("rem"), bookingId, "reminder", "sent", detail, now),
    db.prepare("UPDATE bookings SET reminder_status = 'sent' WHERE id = ?").bind(bookingId),
  ]);
}
