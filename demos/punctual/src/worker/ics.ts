import { icsUtcStamp } from "../shared/schedule";
import type { Booking, Host } from "../shared/types";

function fold(line: string): string {
  if (line.length <= 74) return line;
  const parts = [line.slice(0, 74)];
  let rest = line.slice(74);
  while (rest.length) {
    parts.push(` ${rest.slice(0, 73)}`);
    rest = rest.slice(73);
  }
  return parts.join("\r\n");
}

function icsText(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll(";", "\\;").replaceAll(",", "\\,").replaceAll("\n", "\\n");
}

export function bookingIcs(host: Host, booking: Booking, method: "REQUEST" | "CANCEL", origin: string): string {
  const now = icsUtcStamp(Date.now());
  const start = icsUtcStamp(Date.parse(booking.slotStart));
  const end = icsUtcStamp(Date.parse(booking.slotEnd));
  const uid = `${booking.id}@punctual`;
  const summary = `${host.title} with ${host.name}`;
  const status = method === "CANCEL" ? "CANCELLED" : "CONFIRMED";
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//tech-demos//punctual//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${method}`,
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${now}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    fold(`SUMMARY:${icsText(summary)}`),
    fold(`DESCRIPTION:${icsText(`Booked via Punctual. ${origin}`)}`),
    fold(`ORGANIZER;CN=${icsText(host.name)}:MAILTO:host@${host.id}.punctual`),
    fold(`ATTENDEE;CN=${icsText(booking.guestName)};RSVP=TRUE:MAILTO:${booking.guestEmail}`),
    `STATUS:${status}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.join("\r\n")}\r\n`;
}
