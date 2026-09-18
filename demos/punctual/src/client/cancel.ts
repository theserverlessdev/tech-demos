import type { Booking, HostPublic } from "../shared/types";
import { formatSlotRange } from "../shared/schedule";

const API_BASE = location.pathname.startsWith("/demos/punctual") ? "/demos/punctual" : "";
const params = new URLSearchParams(location.search);
const id = params.get("id") ?? "";
const token = params.get("t") ?? "";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function main() {
  if (!id) {
    $("title").textContent = "Missing booking.";
    return;
  }
  const hostRes = await fetch(`${API_BASE}/api/host`);
  const hostJson = (await hostRes.json()) as HostPublic;
  const res = await fetch(`${API_BASE}/api/bookings/${encodeURIComponent(id)}`);
  const json = (await res.json()) as { booking?: Booking; error?: { message: string } };
  if (!res.ok || !json.booking) {
    $("title").textContent = json.error?.message || "That booking is gone.";
    return;
  }
  const booking = json.booking;
  const when = formatSlotRange(booking.slotStart, booking.slotEnd, hostJson.host);
  $("when").textContent = `${booking.guestName} · ${when}`;
  if (booking.status === "cancelled") {
    $("eyebrow").textContent = "Cancelled";
    $("title").textContent = "This slot is free again.";
    return;
  }
  $("title").textContent = "Cancel this booking?";
  const btn = $("cancel") as HTMLButtonElement;
  btn.hidden = false;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const cancel = await fetch(`${API_BASE}/api/bookings/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ t: token }),
    });
    const body = (await cancel.json()) as { booking?: Booking; error?: { message: string } };
    if (!cancel.ok) {
      $("hint").textContent = body.error?.message || "Cancel failed.";
      $("hint").dataset.tone = "error";
      btn.disabled = false;
      return;
    }
    $("eyebrow").textContent = "Cancelled";
    $("title").textContent = "This slot is free again.";
    $("hint").textContent = "The lock is gone. Someone else can take this time.";
    btn.hidden = true;
  });
}

void main();
