// Smoke: bun run scripts/smoke.ts [baseUrl]
import type { Availability, Booking, Health } from "../src/shared/types";

const base = (process.argv.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:8787").replace(/\/$/, "");

let failures = 0;
function check(label: string, ok: unknown, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const res = await fetch(`${base}/api${path}`, { method: init.method ?? "GET", headers, body });
  const text = await res.text();
  let data: T | null = null;
  try {
    data = JSON.parse(text) as T;
  } catch {
    data = null;
  }
  return { status: res.status, data, text };
}

function firstSlot(avail: Availability | null): string | null {
  return avail?.days[0]?.slots[0]?.start ?? null;
}

console.log(`Target: ${base}`);

const health = await call<Health>("/health");
check("health is ok", health.status === 200 && health.data?.ok === true, health.data);

const host = await call<{ host: { id: string } }>("/host");
check("host is ankur", host.status === 200 && host.data?.host.id === "ankur", host.data);

const avail1 = await call<Availability>("/availability");
check("availability returns days with open slots", Boolean(avail1.data && avail1.data.days.length > 0 && avail1.data.days[0]!.slots.length > 0), {
  days: avail1.data?.days.length,
  firstOpen: avail1.data?.days[0]?.openCount,
  source: avail1.data?.source,
});

const avail2 = await call<Availability>("/availability");
check("second availability may be served from KV", avail2.status === 200 && Boolean(avail2.data?.days.length), avail2.data?.source);

const slotA = firstSlot(avail1.data);
if (!slotA) {
  console.error("No open slot to book; cannot continue.");
  process.exit(1);
}

const stamp = Date.now().toString(36);
const [left, right] = await Promise.all([
  call<{ booking: Booking; error?: { code: string } }>("/book", {
    method: "POST",
    body: { slotStart: slotA, guestName: "Smoke Alpha", guestEmail: `alpha.${stamp}@example.com` },
  }),
  call<{ booking: Booking; error?: { code: string } }>("/book", {
    method: "POST",
    body: { slotStart: slotA, guestName: "Smoke Beta", guestEmail: `beta.${stamp}@example.com` },
  }),
]);

const statuses = [left.status, right.status].sort((a, b) => a - b);
const winner = left.status === 201 ? left : right.status === 201 ? right : null;
const loser = left.status === 201 ? right : left;
check("concurrent book: one 201", statuses[0] === 201 || statuses[1] === 201, statuses);
check("concurrent book: one 409 slot_taken", loser.status === 409 && (loser.data as { error?: { code: string } })?.error?.code === "slot_taken", {
  status: loser.status,
  data: loser.data,
});
check("winner has a booking id", Boolean(winner?.data?.booking?.id), winner?.data);

const after = await call<Availability>("/availability");
const stillOpen = after.data?.days.some((d) => d.slots.some((s) => s.start === slotA));
check("booked slot is gone after refresh", stillOpen === false, { slotA, source: after.data?.source });

if (winner?.data?.booking?.id) {
  const id = winner.data.booking.id;
  let sent = false;
  for (let i = 0; i < 15; i++) {
    const row = await call<{ booking: Booking }>(`/bookings/${id}`);
    if (row.data?.booking.reminderStatus === "sent") {
      sent = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  check("queue consumer marks reminder sent", sent, { id });
}

const bad = await call("/book", { method: "POST", body: { slotStart: slotA, guestName: "X", guestEmail: "not-an-email" } });
check("invalid email is 400", bad.status === 400, bad.data);

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll smoke checks passed.");
