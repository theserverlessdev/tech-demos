// Smoke: bun run scripts/smoke.ts [baseUrl]
import { slotOverlapsBusy } from "../src/shared/schedule";
import type { Availability, BookResponse, Booking, GoogleStatus, Health } from "../src/shared/types";

const base = (process.argv.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const adminKey = process.env.ADMIN_API_KEY?.trim() || "dev-admin-key";

let failures = 0;
function check(label: string, ok: unknown, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}

async function call<T>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; raw?: boolean } = {}) {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const res = await fetch(`${base}/api${path}`, { method: init.method ?? "GET", headers, body });
  const text = await res.text();
  if (init.raw) return { status: res.status, data: null as T | null, text };
  let data: T | null = null;
  try {
    data = JSON.parse(text) as T;
  } catch {
    data = null;
  }
  return { status: res.status, data, text };
}

function tokenFromLink(url: string): string {
  try {
    return new URL(url).searchParams.get("t") ?? "";
  } catch {
    return "";
  }
}

function firstSlot(avail: Availability | null): string | null {
  return avail?.days[0]?.slots[0]?.start ?? null;
}

function slotWithinHours(avail: Availability | null, hours: number): string | null {
  const cutoff = Date.now() + hours * 3600_000;
  for (const day of avail?.days ?? []) {
    for (const slot of day.slots) {
      const t = Date.parse(slot.start);
      if (Number.isFinite(t) && t <= cutoff) return slot.start;
    }
  }
  return null;
}

console.log(`Target: ${base}`);

const health = await call<Health>("/health");
check("health is ok", health.status === 200 && health.data?.ok === true, health.data);
check("mail is fail-soft without Resend", health.data?.mail.resend === false, health.data?.mail);
check("turnstile default off", health.data?.turnstile === false, health.data?.turnstile);
check("google unconfigured without client secrets", health.data?.google.configured === false, health.data?.google);

check(
  "busy overlap helper",
  slotOverlapsBusy({ start: "2026-09-19T16:00:00.000Z", end: "2026-09-19T16:30:00.000Z" }, [
    { start: "2026-09-19T16:15:00.000Z", end: "2026-09-19T17:00:00.000Z" },
  ]) &&
    !slotOverlapsBusy({ start: "2026-09-19T16:00:00.000Z", end: "2026-09-19T16:30:00.000Z" }, [
      { start: "2026-09-19T17:00:00.000Z", end: "2026-09-19T17:30:00.000Z" },
    ]),
);

const host = await call<{ host: { id: string } }>("/host");
check("host is ankur", host.status === 200 && host.data?.host.id === "ankur", host.data);

const avail1 = await call<Availability>("/availability");
check("availability returns days with open slots", Boolean(avail1.data && avail1.data.days.length > 0 && avail1.data.days[0]!.slots.length > 0), {
  days: avail1.data?.days.length,
  firstOpen: avail1.data?.days[0]?.openCount,
  source: avail1.data?.source,
  google: avail1.data?.google,
});
check("availability google is off without OAuth/mock", avail1.data?.google === "off" || avail1.data?.google === "merged", avail1.data?.google);

const googleStart = await call<{ url?: string; error?: { code: string } }>("/google/start", {
  method: "POST",
  body: {},
  headers: { authorization: `Bearer ${adminKey}` },
});
check("google start is 503 when unset", googleStart.status === 503 && (googleStart.data as { error?: { code: string } } | null)?.error?.code === "google_disabled", googleStart.data);

const googleCb = await call("/google/callback");
check("google callback is 503 when unset", googleCb.status === 503, googleCb.data);

const googleStatus = await call<GoogleStatus>("/google/status", { headers: { authorization: `Bearer ${adminKey}` } });
check("google status reports configured false", googleStatus.status === 200 && googleStatus.data?.configured === false && googleStatus.data.connected === false, googleStatus.data);

const avail2 = await call<Availability>("/availability");
check("second availability may be served from KV", avail2.status === 200 && Boolean(avail2.data?.days.length), avail2.data?.source);

const slotA = slotWithinHours(avail1.data, 24) ?? firstSlot(avail1.data);
if (!slotA) {
  console.error("No open slot to book; cannot continue.");
  process.exit(1);
}
const near = slotWithinHours(avail1.data, 24) === slotA;
console.log(`Using slot ${slotA} (${near ? "inside 24h reminder window" : "beyond 24h — reminder stays queued until delay"})`);

const stamp = Date.now().toString(36);
const [left, right] = await Promise.all([
  call<BookResponse>("/book", {
    method: "POST",
    body: { slotStart: slotA, guestName: "Smoke Alpha", guestEmail: `alpha.${stamp}@example.com` },
  }),
  call<BookResponse>("/book", {
    method: "POST",
    body: { slotStart: slotA, guestName: "Smoke Beta", guestEmail: `beta.${stamp}@example.com` },
  }),
]);

const statuses = [left.status, right.status].sort((a, b) => a - b);
const winner = left.status === 201 ? left : right.status === 201 ? right : null;
const loser = left.status === 201 ? right : left;
check("concurrent book: one 201", statuses[0] === 201 || statuses[1] === 201, statuses);
check("concurrent book: one 409 slot_taken", loser.status === 409 && (loser.data as { error?: { code: string } } | null)?.error?.code === "slot_taken", {
  status: loser.status,
  data: loser.data,
});
check("winner has a booking id", Boolean(winner?.data?.booking?.id), winner?.data);
check("email skipped without Resend key", winner?.data?.mail.guest === "skipped", winner?.data?.mail);
check("google write skipped when not connected", winner?.data?.google === "skipped", winner?.data?.google);
check("ICS and cancel links returned", Boolean(winner?.data?.links.ics && winner?.data?.links.cancel), winner?.data?.links);

const after = await call<Availability>("/availability");
const stillOpen = after.data?.days.some((d) => d.slots.some((s) => s.start === slotA));
check("booked slot is gone after refresh", stillOpen === false, { slotA, source: after.data?.source });

const booking = winner?.data?.booking;
const links = winner?.data?.links;
if (booking && links) {
  const icsToken = tokenFromLink(links.ics);
  const cancelToken = tokenFromLink(links.cancel);

  const denied = await call(`/bookings/${booking.id}/ics`, { raw: true });
  check("ICS without token is 403", denied.status === 403, { status: denied.status, text: denied.text.slice(0, 180) });

  const ics = await call(`/bookings/${booking.id}/ics?t=${encodeURIComponent(icsToken)}`, { raw: true });
  check("signed ICS is text/calendar", ics.status === 200 && ics.text.includes("BEGIN:VCALENDAR") && ics.text.includes("METHOD:REQUEST"), {
    status: ics.status,
    head: ics.text.slice(0, 120),
  });

  const unsignedCancel = await call(`/bookings/${booking.id}/cancel`, { method: "POST", body: {} });
  check("unsigned cancel is 403", unsignedCancel.status === 403, unsignedCancel.data);

  const admin = await call<{ bookings: Booking[] }>("/admin/bookings", {
    headers: { authorization: `Bearer ${adminKey}` },
  });
  if (admin.status === 503) {
    check("admin disabled when key unset (503)", true);
  } else {
    check("admin list includes the booking", admin.status === 200 && Boolean(admin.data?.bookings.some((row) => row.id === booking.id)), {
      status: admin.status,
      ids: admin.data?.bookings.map((row) => row.id),
    });
  }

  let reminder: Booking["reminderStatus"] | undefined;
  for (let i = 0; i < 12; i++) {
    const row = await call<{ booking: Booking }>(`/bookings/${booking.id}`);
    reminder = row.data?.booking.reminderStatus;
    if (reminder && reminder !== "queued") break;
    await new Promise((r) => setTimeout(r, 700));
  }
  if (near) {
    check("reminder inside 24h is skipped without Resend", reminder === "skipped", { reminder });
  } else {
    check("reminder beyond 24h stays queued (or skipped if consumer ran)", reminder === "queued" || reminder === "skipped", { reminder });
  }

  const cancelled = await call<{ booking: Booking; cancelled: boolean }>(`/bookings/${booking.id}/cancel`, {
    method: "POST",
    body: { t: cancelToken },
  });
  check("signed cancel returns cancelled", cancelled.status === 200 && cancelled.data?.cancelled === true && cancelled.data.booking.status === "cancelled", cancelled.data);

  const freed = await call<Availability>("/availability");
  const openAgain = freed.data?.days.some((d) => d.slots.some((s) => s.start === slotA));
  check("cancelled slot is bookable again", openAgain === true, { slotA, source: freed.data?.source });

  const afterCancel = await call<{ booking: Booking }>(`/bookings/${booking.id}`);
  check("cancelled booking reminder is not left queued", afterCancel.data?.booking.reminderStatus !== "queued", afterCancel.data?.booking.reminderStatus);
}

const bad = await call("/book", { method: "POST", body: { slotStart: slotA, guestName: "X", guestEmail: "not-an-email" } });
check("invalid email is 400", bad.status === 400, bad.data);

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll smoke checks passed.");
