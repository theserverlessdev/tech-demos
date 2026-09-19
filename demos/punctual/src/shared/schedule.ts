import type { BusyInterval, DayAvailability, Host, Slot } from "./types";

export const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export const DEFAULT_HOST: Host = {
  id: "ankur",
  name: "Ankur Singh",
  title: "Office hours",
  timezone: "America/Los_Angeles",
  timezoneLabel: "Pacific Time",
  slotMinutes: 30,
  startHour: 9,
  startMinute: 0,
  endHour: 17,
  endMinute: 0,
  weekdays: ["Mon", "Tue", "Wed", "Thu", "Fri"],
  horizonDays: 14,
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type Parts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: string;
};

function tzFmt(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

export function zonedParts(ms: number, timeZone: string): Parts {
  const bag: Record<string, string> = {};
  for (const part of tzFmt(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== "literal") bag[part.type] = part.value;
  }
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour: Number(bag.hour),
    minute: Number(bag.minute),
    weekday: bag.weekday ?? "",
  };
}

/** Wall-clock time in `timeZone` → UTC epoch ms. */
export function zonedToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const seen = zonedParts(utcGuess, timeZone);
  const asUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, 0);
  return utcGuess - (asUtc - utcGuess);
}

export function dateKey(ms: number, timeZone: string): string {
  const p = zonedParts(ms, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function formatClock(hour: number, minute: number): string {
  const ampm = hour >= 12 ? "PM" : "AM";
  const h = hour % 12 || 12;
  return `${h}:${String(minute).padStart(2, "0")} ${ampm}`;
}

export function timezoneLabel(timeZone: string): string {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortGeneric" })
      .formatToParts(new Date())
      .find((part) => part.type === "timeZoneName")?.value;
    return name || timeZone;
  } catch {
    return timeZone;
  }
}

export function formatSlotRange(startIso: string, endIso: string, host: Host): string {
  const start = zonedParts(Date.parse(startIso), host.timezone);
  const end = zonedParts(Date.parse(endIso), host.timezone);
  return `${start.weekday} ${start.day} ${MONTHS[start.month - 1]} · ${formatClock(start.hour, start.minute)}–${formatClock(end.hour, end.minute)} ${host.timezoneLabel}`;
}

export function parseClock(value: string, fallbackHour: number, fallbackMinute = 0): { hour: number; minute: number } {
  const match = /^(\d{1,2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return { hour: fallbackHour, minute: fallbackMinute };
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? fallbackMinute);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return { hour: fallbackHour, minute: fallbackMinute };
  return { hour, minute };
}

export function parseWeekdays(value: string | undefined): string[] {
  if (!value?.trim()) return [...DEFAULT_HOST.weekdays];
  const allowed = new Set<string>(WEEKDAY_NAMES);
  const parsed = value
    .split(",")
    .map((part) => part.trim())
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1, 3).toLowerCase())
    .filter((part) => allowed.has(part));
  return parsed.length ? parsed : [...DEFAULT_HOST.weekdays];
}

export function slotsForDate(host: Host, date: string, now = Date.now()): Slot[] {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return [];
  const startMs = zonedToUtc(host.timezone, year, month, day, host.startHour, host.startMinute);
  const endMs = zonedToUtc(host.timezone, year, month, day, host.endHour, host.endMinute);
  const step = host.slotMinutes * 60_000;
  const slots: Slot[] = [];
  for (let t = startMs; t + step <= endMs; t += step) {
    if (t <= now) continue;
    const p = zonedParts(t, host.timezone);
    slots.push({
      start: new Date(t).toISOString(),
      end: new Date(t + step).toISOString(),
      date,
      label: formatClock(p.hour, p.minute),
    });
  }
  return slots;
}

export function slotOverlapsBusy(slot: Pick<Slot, "start" | "end">, busy: BusyInterval[]): boolean {
  const a = Date.parse(slot.start);
  const b = Date.parse(slot.end);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return busy.some((iv) => {
    const start = Date.parse(iv.start);
    const end = Date.parse(iv.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    return a < end && b > start;
  });
}

export function availabilityWindow(host: Host, now = Date.now()): { timeMin: string; timeMax: string } {
  return {
    timeMin: new Date(now).toISOString(),
    timeMax: new Date(now + (host.horizonDays + 2) * 24 * 60 * 60 * 1000).toISOString(),
  };
}

/** `taken` is the set of booked slot_start ISO strings. */
export function availabilityFromLocks(
  host: Host,
  taken: Set<string>,
  now = Date.now(),
  busy: BusyInterval[] = [],
): DayAvailability[] {
  const days: DayAvailability[] = [];
  const today = zonedParts(now, host.timezone);
  let cursor = zonedToUtc(host.timezone, today.year, today.month, today.day, 12, 0);
  const openDays = new Set(host.weekdays);
  for (let i = 0; i < host.horizonDays + 10 && days.length < 10; i++) {
    const p = zonedParts(cursor, host.timezone);
    if (openDays.has(p.weekday)) {
      const date = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
      const slots = slotsForDate(host, date, now).filter((slot) => !taken.has(slot.start) && !slotOverlapsBusy(slot, busy));
      if (slots.length > 0) {
        days.push({
          date,
          weekday: p.weekday,
          label: `${p.weekday} ${p.day} ${MONTHS[p.month - 1]}`,
          openCount: slots.length,
          slots,
        });
      }
    }
    cursor += 24 * 60 * 60 * 1000;
  }
  return days;
}

export function findGeneratedSlot(host: Host, slotStart: string, now = Date.now()): Slot | null {
  const ms = Date.parse(slotStart);
  if (!Number.isFinite(ms)) return null;
  return slotsForDate(host, dateKey(ms, host.timezone), now).find((slot) => slot.start === slotStart) ?? null;
}

export function icsUtcStamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}
