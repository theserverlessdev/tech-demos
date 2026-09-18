export type ReminderStatus = "queued" | "sent" | "skipped" | "failed";
export type MailStatus = "sent" | "skipped" | "failed";
export type BookingStatus = "confirmed" | "cancelled";

export type Host = {
  id: string;
  name: string;
  title: string;
  timezone: string;
  timezoneLabel: string;
  slotMinutes: number;
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
  weekdays: string[];
  horizonDays: number;
};

export type Slot = {
  start: string;
  end: string;
  date: string;
  label: string;
};

export type DayAvailability = {
  date: string;
  weekday: string;
  label: string;
  openCount: number;
  slots: Slot[];
};

export type Availability = {
  host: Host;
  source: "kv" | "d1";
  days: DayAvailability[];
};

export type Booking = {
  id: string;
  hostId: string;
  guestName: string;
  guestEmail: string;
  slotStart: string;
  slotEnd: string;
  createdAt: number;
  status: BookingStatus;
  reminderStatus: ReminderStatus;
  mailStatus: MailStatus;
};

export type BookRequest = {
  slotStart: string;
  guestName: string;
  guestEmail: string;
  turnstileToken?: string;
};

export type BookResult =
  | { ok: true; booking: Booking }
  | { ok: false; code: "slot_taken" | "slot_invalid" | "slot_past"; message: string };

export type MailResult = {
  guest: MailStatus;
  host: MailStatus;
};

export type BookResponse = {
  booking: Booking;
  mail: MailResult;
  links: { ics: string; cancel: string };
};

export type ReminderMessage = {
  bookingId: string;
  sendAt: number;
  kind: "reminder";
};

export type Health = {
  ok: true;
  hostId: string;
  bookings: number;
  reminders: number;
  mail: { resend: boolean; from: string | null };
  turnstile: boolean;
  admin: boolean;
  signing: "secret" | "dev-fallback";
};

export type HostPublic = {
  host: Host;
  turnstileSiteKey: string | null;
  mailEnabled: boolean;
};
