import type { Availability, Booking, DayAvailability, Host } from "../shared/types";
import { formatSlotRange, HOST } from "../shared/schedule";

const API_BASE = location.pathname.startsWith("/demos/punctual") ? "/demos/punctual" : "";

class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api${path}`, { method: init.method ?? "GET", headers, body });
  } catch {
    throw new ApiFailure(0, "network", "The network request failed.");
  }
  const data = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
  if (!res.ok) throw new ApiFailure(res.status, data?.error?.code ?? "http", data?.error?.message ?? `HTTP ${res.status}`);
  return data as T;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const state = {
  host: HOST as Host,
  days: [] as DayAvailability[],
  source: "d1" as "kv" | "d1",
  selectedDate: null as string | null,
  selectedStart: null as string | null,
  booking: null as Booking | null,
};

function setStrip(text: string, stateName: "" | "kv" | "d1" | "error" = "") {
  $("strip-text").textContent = text;
  const strip = $("strip");
  if (stateName) strip.dataset.state = stateName;
  else delete strip.dataset.state;
}

function setHint(message: string, tone: "" | "ok" | "error" = "") {
  const el = $("form-hint");
  el.textContent = message;
  if (tone) el.dataset.tone = tone;
  else delete el.dataset.tone;
}

function showView(view: "picker" | "confirm" | "done") {
  $("picker").hidden = view !== "picker";
  $("confirm").hidden = view !== "confirm";
  $("done").hidden = view !== "done";
}

function selectedDay(): DayAvailability | undefined {
  return state.days.find((d) => d.date === state.selectedDate);
}

function selectedSlot() {
  return selectedDay()?.slots.find((s) => s.start === state.selectedStart);
}

function renderDays() {
  const root = $("days");
  root.replaceChildren(
    ...state.days.map((day) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "day" + (day.date === state.selectedDate ? " is-on" : "");
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", day.date === state.selectedDate ? "true" : "false");
      btn.innerHTML = `<span class="day__wk">${day.weekday}</span><span class="day__n">${day.date.slice(8)}</span><span class="day__open">${day.openCount} open</span>`;
      btn.addEventListener("click", () => {
        state.selectedDate = day.date;
        state.selectedStart = null;
        renderDays();
        renderSlots();
      });
      return btn;
    }),
  );
  $("day-count").textContent = String(state.days.length);
}

function renderSlots() {
  const day = selectedDay();
  const slots = day?.slots ?? [];
  $("slot-count").textContent = String(slots.length);
  $("slots-empty").hidden = slots.length > 0;
  const root = $("slots");
  root.replaceChildren(
    ...slots.map((slot) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "slot" + (slot.start === state.selectedStart ? " is-on" : "");
      btn.textContent = slot.label;
      btn.addEventListener("click", () => {
        state.selectedStart = slot.start;
        $("confirm-when").textContent = formatSlotRange(slot.start, slot.end);
        showView("confirm");
        $("name").focus();
      });
      return btn;
    }),
  );
}

function renderHost() {
  $("host-name").textContent = state.host.name;
  $("host-meta").textContent = `${state.host.title} · ${state.host.timezoneLabel} · weekdays ${state.host.startHour}:00–${state.host.endHour}:00`;
  $("confirm-host").textContent = `${state.host.name} · ${state.host.slotMinutes} min · ${state.host.timezoneLabel}`;
}

async function loadAvailability() {
  setStrip("Loading open slots…");
  const data = await api<Availability>("/availability");
  state.host = data.host;
  state.days = data.days;
  state.source = data.source;
  state.selectedDate = data.days[0]?.date ?? null;
  renderHost();
  renderDays();
  renderSlots();
  const n = data.days.reduce((sum, d) => sum + d.openCount, 0);
  setStrip(
    data.source === "kv"
      ? `KV cache hit · ${n} open slots across ${data.days.length} days.`
      : `D1 miss-fill · ${n} open slots cached to KV.`,
    data.source,
  );
}

async function submit(event: Event) {
  event.preventDefault();
  const slot = selectedSlot();
  if (!slot) return;
  const guestName = ($("name") as HTMLInputElement).value.trim();
  const guestEmail = ($("email") as HTMLInputElement).value.trim();
  const submitBtn = $("submit") as HTMLButtonElement;
  submitBtn.disabled = true;
  setHint("Booking through the Durable Object…");
  try {
    const result = await api<{ booking: Booking }>("/book", {
      method: "POST",
      body: { slotStart: slot.start, guestName, guestEmail },
    });
    state.booking = result.booking;
    $("done-when").textContent = formatSlotRange(result.booking.slotStart, result.booking.slotEnd);
    $("done-id").textContent = result.booking.id;
    $("done-hint").textContent = "A reminder stub was queued. This demo does not send real email.";
    showView("done");
    setStrip("Booked. KV cache invalidated. Reminder queued.", "kv");
    pollReminder(result.booking.id);
  } catch (err) {
    const fail = err instanceof ApiFailure ? err : new ApiFailure(0, "unknown", "Booking failed.");
    setHint(fail.message, "error");
    if (fail.code === "slot_taken") {
      await loadAvailability().catch(() => undefined);
      showView("picker");
      setStrip("That slot was taken. Pick another time.", "error");
    }
  } finally {
    submitBtn.disabled = false;
  }
}

async function pollReminder(id: string) {
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 800));
    try {
      const data = await api<{ booking: Booking }>(`/bookings/${id}`);
      if (data.booking.reminderStatus === "sent") {
        $("done-hint").textContent = "Queue consumer stored reminder_status=sent (no email provider).";
        setStrip("Booked. Reminder stub recorded in D1.", "kv");
        return;
      }
    } catch {
      return;
    }
  }
}

$("theme").addEventListener("click", () => {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try {
    localStorage.setItem("theme", next);
  } catch {
    /* ignore */
  }
});

$("back").addEventListener("click", () => {
  state.selectedStart = null;
  setHint("");
  showView("picker");
  renderSlots();
});

$("again").addEventListener("click", async () => {
  ($("name") as HTMLInputElement).value = "";
  ($("email") as HTMLInputElement).value = "";
  state.selectedStart = null;
  state.booking = null;
  showView("picker");
  await loadAvailability();
});

$("confirm").addEventListener("submit", submit);

loadAvailability().catch((err) => {
  setStrip(err instanceof Error ? err.message : "Failed to load availability.", "error");
});
