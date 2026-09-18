import type { Availability, Booking, BookResponse, DayAvailability, Host, HostPublic, MailResult } from "../shared/types";
import { formatClock, formatSlotRange } from "../shared/schedule";

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
  host: null as Host | null,
  mailEnabled: false,
  turnstileSiteKey: null as string | null,
  days: [] as DayAvailability[],
  source: "d1" as "kv" | "d1",
  selectedDate: null as string | null,
  selectedStart: null as string | null,
  booking: null as Booking | null,
  links: null as BookResponse["links"] | null,
  mail: null as MailResult | null,
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
        const host = state.host;
        if (host) $("confirm-when").textContent = formatSlotRange(slot.start, slot.end, host);
        showView("confirm");
        $("name").focus();
      });
      return btn;
    }),
  );
}

function renderHost() {
  const host = state.host;
  if (!host) return;
  $("host-name").textContent = host.name;
  $("host-meta").textContent = `${host.title} · ${host.timezoneLabel} · ${host.weekdays.join(", ")} ${formatClock(host.startHour, host.startMinute)}–${formatClock(host.endHour, host.endMinute)}`;
  $("confirm-host").textContent = `${host.name} · ${host.slotMinutes} min · ${host.timezoneLabel}`;
  $("slot-mins").textContent = `${host.slotMinutes} minutes`;
}

function mailCopy(mail: MailResult | null): string {
  if (!mail) return "Booking saved.";
  if (mail.guest === "sent") return "Confirmation email sent with an .ics calendar invite.";
  if (mail.guest === "failed") return "Booked, but email failed. Download the calendar file below.";
  return "Email skipped (no Resend key on this Worker). Download the calendar file to add it yourself.";
}

function ensureTurnstile(siteKey: string) {
  if (document.getElementById("cf-turnstile-script")) return;
  const box = $("turnstile");
  box.hidden = false;
  const script = document.createElement("script");
  script.id = "cf-turnstile-script";
  script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
  script.async = true;
  script.onload = () => {
    const w = window as unknown as { turnstile?: { render: (el: string, opts: { sitekey: string }) => void } };
    w.turnstile?.render("#turnstile", { sitekey: siteKey });
  };
  document.head.appendChild(script);
}

async function loadAvailability() {
  setStrip("Loading open slots…");
  const meta = await api<HostPublic>("/host");
  state.host = meta.host;
  state.mailEnabled = meta.mailEnabled;
  state.turnstileSiteKey = meta.turnstileSiteKey;
  if (meta.turnstileSiteKey) ensureTurnstile(meta.turnstileSiteKey);
  renderHost();
  const data = await api<Availability>("/availability");
  state.days = data.days;
  state.source = data.source;
  state.selectedDate = data.days[0]?.date ?? null;
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

function turnstileToken(): string {
  const input = document.querySelector<HTMLInputElement>("[name=cf-turnstile-response]");
  return input?.value ?? "";
}

async function submit(event: Event) {
  event.preventDefault();
  const slot = selectedSlot();
  const host = state.host;
  if (!slot || !host) return;
  const guestName = ($("name") as HTMLInputElement).value.trim();
  const guestEmail = ($("email") as HTMLInputElement).value.trim();
  const submitBtn = $("submit") as HTMLButtonElement;
  submitBtn.disabled = true;
  setHint("Booking through the Durable Object…");
  try {
    const result = await api<BookResponse>("/book", {
      method: "POST",
      body: { slotStart: slot.start, guestName, guestEmail, turnstileToken: turnstileToken() },
    });
    state.booking = result.booking;
    state.links = result.links;
    state.mail = result.mail;
    $("done-when").textContent = formatSlotRange(result.booking.slotStart, result.booking.slotEnd, host);
    $("done-id").textContent = result.booking.id;
    $("done-hint").textContent = mailCopy(result.mail);
    ($("done-ics") as HTMLAnchorElement).href = result.links.ics;
    ($("done-cancel") as HTMLAnchorElement).href = result.links.cancel;
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
      const status = data.booking.reminderStatus;
      if (status === "sent" || status === "skipped" || status === "failed") {
        const extra =
          status === "sent"
            ? " Reminder email is on its way (or already sent if the slot is inside 24h)."
            : status === "skipped"
              ? " Reminder marked skipped (no Resend key)."
              : " Reminder send failed; the booking still stands.";
        $("done-hint").textContent = mailCopy(state.mail) + extra;
        setStrip(
          status === "sent"
            ? "Booked. Reminder email handled (sent, or already inside the 24h window)."
            : status === "skipped"
              ? "Booked. Reminder skipped — no Resend key on this Worker."
              : "Booked. Reminder send failed; the booking still stands.",
          status === "failed" ? "error" : "kv",
        );
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
