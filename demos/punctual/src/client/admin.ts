import type { Booking, HostPublic } from "../shared/types";
import { formatSlotRange } from "../shared/schedule";

const API_BASE = location.pathname.startsWith("/demos/punctual") ? "/demos/punctual" : "";
const KEY = "punctual-admin-key";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function call<T>(path: string, key: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; data: T | null; message: string }> {
  const headers: Record<string, string> = { authorization: `Bearer ${key}` };
  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const res = await fetch(`${API_BASE}/api${path}`, { method: init.method ?? "GET", headers, body });
  const json = (await res.json().catch(() => null)) as { error?: { message: string } } | T | null;
  const message =
    json && typeof json === "object" && "error" in json && json.error?.message ? json.error.message : `HTTP ${res.status}`;
  return { status: res.status, data: res.ok ? (json as T) : null, message };
}

async function load(key: string) {
  $("hint").textContent = "Loading…";
  const host = await call<HostPublic>("/host", key);
  const list = await call<{ bookings: Booking[] }>("/admin/bookings", key);
  if (list.status === 503 || list.status === 401) {
    $("hint").textContent = list.message;
    $("hint").dataset.tone = "error";
    return;
  }
  const bookings = list.data?.bookings ?? [];
  $("gate").hidden = true;
  $("list").hidden = false;
  $("count").textContent = String(bookings.length);
  $("empty").hidden = bookings.length > 0;
  const hostInfo = host.data?.host;
  const rows = $("rows");
  rows.replaceChildren(
    ...bookings.map((booking) => {
      const tr = document.createElement("tr");
      const when = hostInfo ? formatSlotRange(booking.slotStart, booking.slotEnd, hostInfo) : booking.slotStart;
      tr.innerHTML = `<td>${when}</td><td>${booking.guestName}<br><span class="mono">${booking.guestEmail}</span></td><td>${booking.mailStatus}</td><td>${booking.reminderStatus}</td>`;
      const td = document.createElement("td");
      const btn = document.createElement("button");
      btn.className = "btn";
      btn.type = "button";
      btn.textContent = "Cancel";
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        await call(`/bookings/${booking.id}/cancel`, key, { method: "POST" });
        await load(key);
      });
      td.append(btn);
      tr.append(td);
      return tr;
    }),
  );
}

$("gate").addEventListener("submit", async (event) => {
  event.preventDefault();
  const key = ($("key") as HTMLInputElement).value.trim();
  try {
    sessionStorage.setItem(KEY, key);
  } catch {
    /* ignore */
  }
  await load(key);
});

const stored = sessionStorage.getItem(KEY);
if (stored) {
  ($("key") as HTMLInputElement).value = stored;
  void load(stored);
}
