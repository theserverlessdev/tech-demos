import type { AuditRow, ClefModel, GateCard, GateDecision, PublicConfig, SessionView } from "../shared/types";

const PROMPTS: Record<string, string> = {
  read: "Look up the refund policy in the docs",
  fetch: "Fetch https://developers.cloudflare.com/workers-ai/models/clef/",
  email: "Email the customer that the ticket is closed",
  delete: "Delete customer record acct_1842",
  sql: "Run DROP TABLE tickets",
};

type ApiError = { error?: { code?: string; message?: string } };

const $ = <T extends Element>(id: string) => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as unknown as T;
};

const strip = $<HTMLParagraphElement>("strip");
const transcript = $<HTMLOListElement>("transcript");
const text = $<HTMLTextAreaElement>("text");
const send = $<HTMLButtonElement>("send");
const pending = $<HTMLDivElement>("pending");
const pendingText = $<HTMLParagraphElement>("pending-text");
const approve = $<HTMLButtonElement>("approve");
const deny = $<HTMLButtonElement>("deny");
const gateDecision = $<HTMLHeadingElement>("gate-decision");
const gateReason = $<HTMLParagraphElement>("gate-reason");
const bars = $<HTMLUListElement>("bars");
const gateMeta = $<HTMLParagraphElement>("gate-meta");
const audit = $<HTMLOListElement>("audit");
const auditEmpty = $<HTMLParagraphElement>("audit-empty");
const modelHint = $<HTMLParagraphElement>("model-hint");
const testNote = $<HTMLParagraphElement>("test-note");
const turnstileHost = $<HTMLDivElement>("turnstile");

let model: ClefModel = "clef";
let siteKey = "";
let widgetId: string | null = null;
let readyToken: string | null = null;
let tokenWaiter: ((token: string) => void) | null = null;
let busy = false;
let poll: number | null = null;

function api(path: string): string {
  const url = new URL(location.href);
  const dir = url.pathname.endsWith("/") ? url.pathname : url.pathname.replace(/[^/]+$/, "");
  return `${dir}${path.replace(/^\//, "")}`;
}

function say(message: string) {
  strip.textContent = message;
}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; data: T | null }> {
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const res = await fetch(api(path), { method: init.method ?? "GET", headers, body, credentials: "same-origin" });
  const raw = await res.text();
  let data: T | null = null;
  try {
    data = raw ? (JSON.parse(raw) as T) : null;
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

function messageOf(data: unknown, fallback: string): string {
  if (!data || typeof data !== "object" || !("error" in data)) return fallback;
  const error = (data as ApiError).error;
  return error?.message || fallback;
}

type TurnstileApi = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  reset: (id?: string) => void;
  remove: (id: string) => void;
};

function turnstileApi(): TurnstileApi | null {
  const host = window as Window & { turnstile?: TurnstileApi };
  return host.turnstile ?? null;
}

function onToken(token: string) {
  if (tokenWaiter) {
    const wait = tokenWaiter;
    tokenWaiter = null;
    wait(token);
    return;
  }
  readyToken = token;
  send.disabled = busy;
}

function mountTurnstile() {
  const apiRef = turnstileApi();
  if (!apiRef || !siteKey) return;
  if (widgetId) apiRef.remove(widgetId);
  readyToken = null;
  widgetId = apiRef.render(turnstileHost, {
    sitekey: siteKey,
    callback: onToken,
    "error-callback": () => say("Turnstile failed to load. Refresh and try again."),
    "expired-callback": () => {
      readyToken = null;
      send.disabled = true;
    },
  });
}

function takeToken(): Promise<string> {
  if (readyToken) {
    const token = readyToken;
    readyToken = null;
    send.disabled = true;
    turnstileApi()?.reset(widgetId ?? undefined);
    return Promise.resolve(token);
  }
  return new Promise((resolve) => {
    tokenWaiter = (token) => {
      send.disabled = true;
      turnstileApi()?.reset(widgetId ?? undefined);
      resolve(token);
    };
  });
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function setBar(decision: GateDecision, value: number) {
  const fill = document.getElementById(`bar-${decision}`);
  const label = document.getElementById(`n-${decision}`);
  if (fill) fill.style.width = pct(value);
  if (label) label.textContent = pct(value);
}

function renderCard(card: GateCard | null) {
  bars.hidden = !card;
  if (!card) {
    gateDecision.textContent = "No call yet";
    gateReason.textContent = "Send a message. The gate shows allow, deny, and ask-human before any tool runs.";
    gateMeta.textContent = "";
    return;
  }
  const human = card.humanOutcome ? ` · you ${card.humanOutcome === "approve" ? "approved" : card.humanOutcome}` : "";
  gateDecision.textContent = `${card.decision} · ${card.tool}`;
  gateReason.textContent = card.reason;
  for (const key of ["allow", "deny", "ask-human"] as const) setBar(key, card.probabilities[key]);
  gateMeta.textContent = `${card.source} · ${card.model} · ${card.latencyMs} ms · confidence ${pct(card.confidence)} · ${card.argsSummary}${human}`;
}

function renderTranscript(view: SessionView) {
  transcript.replaceChildren();
  if (!view.messages.length) {
    const item = document.createElement("li");
    item.className = "empty";
    item.textContent = "Ask for the refund policy, a URL, an email, a delete, or a SQL statement.";
    transcript.append(item);
    renderCard(null);
    return;
  }
  let latest: GateCard | null = null;
  for (const message of view.messages) {
    if (message.role === "gate" && message.gate) {
      latest = message.gate;
      continue;
    }
    const item = document.createElement("li");
    item.className = `bubble bubble--${message.role}`;
    const role = document.createElement("span");
    role.className = "bubble__role";
    role.textContent = message.role;
    item.append(role, document.createTextNode(message.content));
    transcript.append(item);
  }
  transcript.scrollTop = transcript.scrollHeight;
  renderCard(latest);
}

function renderPending(view: SessionView) {
  pending.dataset.id = view.pending?.id ?? "";
  if (!view.pending) {
    pending.hidden = true;
    if (poll) {
      window.clearInterval(poll);
      poll = null;
    }
    return;
  }
  pending.hidden = false;
  pendingText.textContent = `${view.pending.tool} · ${view.pending.argsSummary}. The call is paused in the agent until you choose.`;
  if (!poll) poll = window.setInterval(() => void refresh(), 4000);
}

function renderAudit(rows: AuditRow[]) {
  audit.replaceChildren();
  auditEmpty.hidden = rows.length > 0;
  for (const row of rows) {
    const item = document.createElement("li");
    item.className = "audit__item";
    const tag = document.createElement("span");
    tag.className = `tag tag--${row.decision}`;
    tag.textContent = row.humanOutcome ? `${row.decision} → ${row.humanOutcome}` : row.decision;
    item.append(document.createTextNode(`${row.tool} · ${row.argsSummary} · `), tag);
    audit.append(item);
  }
}

function paintModel() {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-model]")) {
    const on = button.dataset.model === model;
    button.classList.toggle("is-on", on);
    button.setAttribute("aria-pressed", on ? "true" : "false");
  }
  modelHint.textContent = model === "clef" ? "27B. One choice question per tool call." : "9B flash. Same question, lower latency.";
}

async function refresh() {
  const session = await call<SessionView>("/api/session");
  if (session.status === 401 || session.status === 410) return;
  if (session.data && "messages" in session.data) {
    model = session.data.model;
    paintModel();
    renderTranscript(session.data);
    renderPending(session.data);
  }
  const log = await call<{ decisions: AuditRow[] }>("/api/audit");
  if (log.data?.decisions) renderAudit(log.data.decisions);
}

async function sendText(value: string) {
  if (busy) return;
  const trimmed = value.trim();
  if (!trimmed) return;
  busy = true;
  send.disabled = true;
  approve.disabled = true;
  deny.disabled = true;
  say("Asking the gate…");
  try {
    const turnstileToken = await takeToken();
    const res = await call<SessionView & ApiError>("/api/chat", {
      method: "POST",
      body: { text: trimmed, model, turnstileToken },
    });
    if (!res.data || !("messages" in res.data)) {
      say(messageOf(res.data, "The desk did not accept that message."));
      return;
    }
    text.value = "";
    model = res.data.model;
    paintModel();
    renderTranscript(res.data);
    renderPending(res.data);
    say(res.data.pending ? "The tool call is paused inside the agent." : "The gate answered.");
    const log = await call<{ decisions: AuditRow[] }>("/api/audit");
    if (log.data?.decisions) renderAudit(log.data.decisions);
  } finally {
    busy = false;
    approve.disabled = false;
    deny.disabled = false;
    send.disabled = !readyToken;
  }
}

async function resolve(outcome: "approve" | "deny") {
  const current = pending.dataset.id;
  if (!current || busy) return;
  busy = true;
  say(outcome === "approve" ? "Approving…" : "Denying…");
  try {
    const turnstileToken = await takeToken();
    const res = await call<SessionView & ApiError>("/api/approvals", {
      method: "POST",
      body: { id: current, outcome, turnstileToken },
    });
    if (!res.data || !("messages" in res.data)) {
      say(messageOf(res.data, "The decision was not recorded."));
      return;
    }
    renderTranscript(res.data);
    renderPending(res.data);
    say(outcome === "approve" ? "You approved the call. It stayed sandboxed." : "You denied the call. It did not run.");
    const log = await call<{ decisions: AuditRow[] }>("/api/audit");
    if (log.data?.decisions) renderAudit(log.data.decisions);
  } finally {
    busy = false;
    send.disabled = !readyToken;
  }
}

document.getElementById("theme")?.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("theme", next);
  } catch {
    /* private mode */
  }
});

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-model]")) {
  button.addEventListener("click", () => {
    const next = button.dataset.model === "clef-flash" ? "clef-flash" : "clef";
    model = next;
    paintModel();
    void call<SessionView>("/api/model", { method: "PATCH", body: { model } }).then((res) => {
      if (res.status === 401) return;
      if (!res.data || !("messages" in res.data)) say(messageOf(res.data, "Could not switch the model."));
    });
  });
}

for (const chip of document.querySelectorAll<HTMLButtonElement>("[data-chip]")) {
  chip.addEventListener("click", () => {
    const prompt = PROMPTS[chip.dataset.chip ?? ""] ?? "";
    text.value = prompt;
    void sendText(prompt);
  });
}

$<HTMLFormElement>("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  void sendText(text.value);
});

approve.addEventListener("click", () => void resolve("approve"));
deny.addEventListener("click", () => void resolve("deny"));

$<HTMLButtonElement>("forget").addEventListener("click", async () => {
  await call("/api/session", { method: "DELETE" });
  transcript.replaceChildren();
  renderCard(null);
  renderAudit([]);
  pending.hidden = true;
  say("New session. The previous audit rows were deleted.");
});

async function boot() {
  const cfg = await call<PublicConfig>("/api/config");
  if (!cfg.data?.turnstileSiteKey) {
    say("The desk did not publish a Turnstile site key.");
    return;
  }
  siteKey = cfg.data.turnstileSiteKey;
  testNote.hidden = !cfg.data.testSiteKey;
  const wait = window.setInterval(() => {
    if (!turnstileApi()) return;
    window.clearInterval(wait);
    mountTurnstile();
  }, 150);
  const session = await call<SessionView>("/api/session");
  if (session.data && "messages" in session.data) {
    model = session.data.model;
    paintModel();
    renderTranscript(session.data);
    renderPending(session.data);
    const log = await call<{ decisions: AuditRow[] }>("/api/audit");
    if (log.data?.decisions) renderAudit(log.data.decisions);
  } else {
    renderCard(null);
  }
}

void boot();
