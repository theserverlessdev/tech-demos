export type ReminderStatus = "queued" | "sent" | "failed";

export type Host = {
  id: string;
  name: string;
  title: string;
  timezone: string;
  timezoneLabel: string;
  slotMinutes: number;
  startHour: number;
  endHour: number;
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
  reminderStatus: ReminderStatus;
};

export type BookRequest = {
  slotStart: string;
  guestName: string;
  guestEmail: string;
};

export type BookResult =
  | { ok: true; booking: Booking }
  | { ok: false; code: "slot_taken" | "slot_invalid" | "slot_past"; message: string };

export type ReminderMessage = {
  bookingId: string;
  hostId: string;
  guestName: string;
  guestEmail: string;
  slotStart: string;
  kind: "reminder";
};

export type Health = {
  ok: true;
  hostId: string;
  bookings: number;
  reminders: number;
};
