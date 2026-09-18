import type { DayAvailability, Host, Slot } from "./types";

export const HOST: Host = {
  id: "ankur",
  name: "Ankur Singh",
  title: "Office hours",
  timezone: "America/Los_Angeles",
  timezoneLabel: "Pacific Time",
  slotMinutes: 30,
  startHour: 9,
  endHour: 17,
  horizonDays: 14,
};

const TZ_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: HOST.timezone,
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type Parts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: string;
};

export function zonedParts(ms: number): Parts {
  const bag: Record<string, string> = {};
  for (const part of TZ_FMT.formatToParts(new Date(ms))) {
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

/** Wall-clock time in the host timezone → UTC epoch ms. */
export function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number): number {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const seen = zonedParts(utcGuess);
  const asUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, 0);
  return utcGuess - (asUtc - utcGuess);
}

export function dateKey(ms: number): string {
  const p = zonedParts(ms);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function formatClock(hour: number, minute: number): string {
  const ampm = hour >= 12 ? "PM" : "AM";
  const h = hour % 12 || 12;
  return `${h}:${String(minute).padStart(2, "0")} ${ampm}`;
}

export function formatSlotRange(startIso: string, endIso: string): string {
  const start = zonedParts(Date.parse(startIso));
  const end = zonedParts(Date.parse(endIso));
  return `${start.weekday} ${start.day} ${MONTHS[start.month - 1]} · ${formatClock(start.hour, start.minute)}–${formatClock(end.hour, end.minute)} ${HOST.timezoneLabel}`;
}

function isWeekend(weekday: string): boolean {
  return weekday === "Sat" || weekday === "Sun";
}

export function slotsForDate(date: string, now = Date.now()): Slot[] {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return [];
  const startMs = zonedToUtc(year, month, day, HOST.startHour, 0);
  const endMs = zonedToUtc(year, month, day, HOST.endHour, 0);
  const step = HOST.slotMinutes * 60_000;
  const slots: Slot[] = [];
  for (let t = startMs; t + step <= endMs; t += step) {
    if (t <= now) continue;
    const p = zonedParts(t);
    slots.push({
      start: new Date(t).toISOString(),
      end: new Date(t + step).toISOString(),
      date,
      label: formatClock(p.hour, p.minute),
    });
  }
  return slots;
}

/** `taken` is the set of booked slot_start ISO strings. */
export function availabilityFromLocks(taken: Set<string>, now = Date.now()): DayAvailability[] {
  const days: DayAvailability[] = [];
  const today = zonedParts(now);
  let cursor = zonedToUtc(today.year, today.month, today.day, 12, 0);
  for (let i = 0; i < HOST.horizonDays + 10 && days.length < 10; i++) {
    const p = zonedParts(cursor);
    if (!isWeekend(p.weekday)) {
      const date = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
      const slots = slotsForDate(date, now).filter((slot) => !taken.has(slot.start));
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

export function findGeneratedSlot(slotStart: string, now = Date.now()): Slot | null {
  const ms = Date.parse(slotStart);
  if (!Number.isFinite(ms)) return null;
  return slotsForDate(dateKey(ms), now).find((slot) => slot.start === slotStart) ?? null;
}
