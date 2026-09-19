import type { Booking, GoogleStatus, HostPublic } from "../shared/types";
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

function renderGoogle(status: GoogleStatus | null, params: URLSearchParams) {
  const connect = $("google-connect") as HTMLButtonElement;
  const disconnect = $("google-disconnect") as HTMLButtonElement;
  const hint = $("google-hint");
  const badge = $("google-state");
  connect.hidden = true;
  disconnect.hidden = true;
  if (params.get("google") === "connected") {
    hint.textContent = "Google Calendar connected. Busy times are hidden on the public page.";
    hint.dataset.tone = "ok";
  } else if (params.get("google") === "error") {
    hint.textContent = `Google connect failed: ${params.get("reason") || "unknown"}.`;
    hint.dataset.tone = "error";
  } else {
    delete hint.dataset.tone;
  }
  if (!status) {
    badge.textContent = "Unknown";
    hint.textContent = hint.textContent || "Could not load Google status.";
    return;
  }
  if (!status.configured) {
    badge.textContent = status.mock ? "Mock" : "Off";
    hint.textContent = status.mock
      ? "GOOGLE_MOCK_BUSY is set. Slots in those intervals are hidden. OAuth stays off until you set client secrets."
      : `Google is off. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then add redirect URI ${status.redirectUri}`;
    return;
  }
  if (status.connected) {
    badge.textContent = "On";
    hint.textContent = `Connected as ${status.email ?? "primary"}. Busy times are hidden; new bookings write a Calendar event.`;
    disconnect.hidden = false;
    return;
  }
  badge.textContent = "Ready";
  hint.textContent = `Redirect URI: ${status.redirectUri}`;
  connect.hidden = false;
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
  const google = await call<GoogleStatus>("/google/status", key);
  const bookings = list.data?.bookings ?? [];
  $("gate").hidden = true;
  $("list").hidden = false;
  $("count").textContent = String(bookings.length);
  $("empty").hidden = bookings.length > 0;
  renderGoogle(google.data, new URLSearchParams(location.search));
  const hostInfo = host.data?.host;
  const rows = $("rows");
  rows.replaceChildren(
    ...bookings.map((booking) => {
      const tr = document.createElement("tr");
      const when = hostInfo ? formatSlotRange(booking.slotStart, booking.slotEnd, hostInfo) : booking.slotStart;
      tr.innerHTML = `<td>${when}</td><td>${booking.guestName}<br><span class="mono">${booking.guestEmail}</span></td><td>${booking.mailStatus}</td><td>${booking.reminderStatus}</td><td>${booking.googleStatus ?? "skipped"}</td>`;
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

$("google-connect").addEventListener("click", async () => {
  const key = sessionStorage.getItem(KEY) || ($("key") as HTMLInputElement).value.trim();
  const start = await call<{ url: string }>("/google/start", key, { method: "POST", body: {} });
  if (!start.data?.url) {
    $("google-hint").textContent = start.message;
    $("google-hint").dataset.tone = "error";
    return;
  }
  location.href = start.data.url;
});

$("google-disconnect").addEventListener("click", async () => {
  const key = sessionStorage.getItem(KEY) || ($("key") as HTMLInputElement).value.trim();
  await call("/google/disconnect", key, { method: "POST", body: {} });
  await load(key);
});

const stored = sessionStorage.getItem(KEY);
if (stored) {
  ($("key") as HTMLInputElement).value = stored;
  void load(stored);
}
