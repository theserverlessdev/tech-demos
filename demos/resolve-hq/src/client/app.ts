import type { Attachment, DraftResult, Health, TicketDetail, TicketPriority, TicketStatus, TicketSummary } from "../shared/types";
import { tokenForAction, type TurnstileWidget, type WidgetAction } from "./session-mint";

const API_BASE = location.pathname.startsWith("/demos/resolve-hq") ? "/demos/resolve-hq" : "";
const POLL_MS = 4000;
const STATUSES: TicketStatus[] = ["open", "pending", "resolved"];
const PRIORITIES: TicketPriority[] = ["low", "normal", "high", "urgent"];
const ASSIGNEES = ["", "Maya Chen", "Jordan Park"];
const TURNSTILE_DUMMY = "XXXX.DUMMY.TOKEN.XXXX";

class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type TurnstileApi = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  reset: (id?: string) => void;
  remove: (id: string) => void;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const state = {
  tickets: [] as TicketSummary[],
  filter: "all" as "all" | TicketStatus,
  selectedId: null as string | null,
  detail: null as TicketDetail | null,
  pollTimer: 0,
  awaitingTicketId: null as string | null,
  awaitingMessageId: null as string | null,
  knownIds: new Set<string>(),
  busy: false,
  health: null as Health | null,
  siteKey: "",
  testSiteKey: false,
};

let widgetId: string | null = null;
let widgetAction: WidgetAction | null = null;
let readyToken: string | null = null;
let tokenWaiter: ((token: string) => void) | null = null;
let sessionReady = false;
let sessionInflight: Promise<void> | null = null;

function turnstileApi(): TurnstileApi | null {
  return (window as Window & { turnstile?: TurnstileApi }).turnstile ?? null;
}

function onToken(token: string) {
  if (tokenWaiter) {
    const wait = tokenWaiter;
    tokenWaiter = null;
    wait(token);
    return;
  }
  readyToken = token;
}

function mountTurnstile(action: WidgetAction) {
  const apiRef = turnstileApi();
  const host = $("turnstile");
  if (!apiRef || !state.siteKey) return;
  if (widgetId) apiRef.remove(widgetId);
  readyToken = null;
  widgetAction = action;
  widgetId = apiRef.render(host, {
    sitekey: state.siteKey,
    action,
    appearance: action === "session" ? "always" : "interaction-only",
    callback: onToken,
    "error-callback": () => setHint("Turnstile failed to load. Refresh and try again.", "error"),
    "expired-callback": () => {
      readyToken = null;
    },
  });
}

function takeToken(): Promise<string> {
  if (readyToken) {
    const token = readyToken;
    readyToken = null;
    turnstileApi()?.reset(widgetId ?? undefined);
    return Promise.resolve(token);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      tokenWaiter = null;
      reject(new Error("Complete the Turnstile check first."));
    }, 30_000);
    tokenWaiter = (token) => {
      clearTimeout(timer);
      turnstileApi()?.reset(widgetId ?? undefined);
      resolve(token);
    };
  });
}

const turnstileWidget: TurnstileWidget = {
  get action() {
    return widgetId ? widgetAction : null;
  },
  mount: mountTurnstile,
  takeToken,
};

async function token(action: WidgetAction): Promise<string | undefined> {
  return tokenForAction(turnstileWidget, action, {
    siteKey: state.siteKey,
    testSiteKey: state.testSiteKey || !state.siteKey,
    dummy: TURNSTILE_DUMMY,
  });
}

async function api<T>(path: string, init: { method?: string; body?: unknown; form?: FormData; retried?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  let body: BodyInit | undefined;
  if (init.form) body = init.form;
  else if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api${path}`, { method: init.method ?? "GET", headers, body, credentials: "same-origin" });
  } catch {
    throw new ApiFailure(0, "network", "The network request failed.");
  }
  if (path.includes("/attachments/") && res.ok && init.method === undefined) return res as T;
  const data = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
  if (!res.ok) {
    const code = data?.error?.code ?? "http";
    if (res.status === 401 && code.startsWith("session") && !init.retried && path !== "/session") {
      sessionReady = false;
      if (state.siteKey && !state.testSiteKey) mountTurnstile("session");
      await ensureSession();
      return api<T>(path, { ...init, retried: true });
    }
    throw new ApiFailure(res.status, code, data?.error?.message ?? `HTTP ${res.status}`);
  }
  return data as T;
}

function isPhone(): boolean {
  return window.matchMedia("(max-width: 960px)").matches;
}

function relTime(ms: number): string {
  const delta = Date.now() - ms;
  const min = Math.round(delta / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h`;
  return new Date(ms).toLocaleDateString();
}

function setHint(message: string, tone: "" | "ok" | "error" = "") {
  const el = $("hint");
  el.textContent = message;
  if (tone) el.dataset.tone = tone;
  else delete el.dataset.tone;
}

function setDraftPath(source: DraftResult["source"] | null, model?: string) {
  const el = $("draft-path");
  if (!source) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent =
    source === "workers-ai" ? `Path: Workers AI · ${model ?? ""}` : `Path: stub fallback · ${model ?? "model"} did not return a usable body`;
  el.dataset.source = source;
}

function fillSelect(el: HTMLSelectElement, values: string[], current: string | null, labels?: Record<string, string>) {
  el.replaceChildren(
    ...values.map((value) => {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = labels?.[value] ?? (value || "Unassigned");
      opt.selected = value === (current ?? "");
      return opt;
    }),
  );
}

function showThread() {
  $("layout").dataset.view = "thread";
}

function showList() {
  $("layout").dataset.view = "list";
}

function renderList() {
  const shown = state.tickets.filter((t) => state.filter === "all" || t.status === state.filter);
  $("count").textContent = String(shown.length);
  const empty = $("list-empty");
  empty.hidden = shown.length > 0;
  const list = $("tickets");
  list.replaceChildren(
    ...shown.map((t) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ticket";
      if (t.id === state.selectedId) btn.classList.add("is-on");
      const top = document.createElement("div");
      top.className = "ticket__top";
      const num = document.createElement("span");
      num.className = "ticket__num";
      num.textContent = `#${t.number}${t.sandbox ? " · yours" : ""}`;
      const chips = document.createElement("span");
      chips.className = "chips";
      const status = document.createElement("span");
      status.className = "chip";
      status.dataset.status = t.status;
      status.textContent = t.status;
      const priority = document.createElement("span");
      priority.className = "chip";
      priority.dataset.priority = t.priority;
      priority.textContent = t.priority;
      chips.append(status, priority);
      top.append(num, chips);
      const subject = document.createElement("div");
      subject.className = "ticket__subject";
      subject.textContent = t.subject;
      const preview = document.createElement("div");
      preview.className = "ticket__preview";
      preview.textContent = t.lastPreview;
      const who = document.createElement("div");
      who.className = "ticket__who";
      who.textContent = `${t.customerName} · ${t.assignee ?? "unassigned"} · ${relTime(t.updatedAt)}`;
      btn.append(top, subject, preview, who);
      btn.addEventListener("click", () => {
        showThread();
        void selectTicket(t.id, { user: true });
      });
      li.append(btn);
      return li;
    }),
  );
}

function renderFiles(attachments: Attachment[]) {
  const wrap = $("files");
  const list = $("files-list");
  wrap.hidden = attachments.length === 0;
  list.replaceChildren(
    ...attachments.map((a) => {
      const li = document.createElement("li");
      const link = document.createElement("a");
      link.href = `${API_BASE}/api/tickets/${a.ticketId}/attachments/${a.id}`;
      link.textContent = `${a.filename} (${a.size} B)`;
      link.setAttribute("download", a.filename);
      li.append(link);
      return li;
    }),
  );
}

function renderThread() {
  const detail = state.detail;
  const empty = $("thread-empty");
  const conv = $("conv");
  const reply = $("reply") as HTMLTextAreaElement;
  const canWrite = Boolean(detail);
  $("draft").toggleAttribute("disabled", !canWrite);
  $("send").toggleAttribute("disabled", !canWrite);
  $("customer-reply").toggleAttribute("disabled", !canWrite);
  $("file").toggleAttribute("disabled", !canWrite);
  $("upload-btn").toggleAttribute("disabled", !canWrite);
  reply.disabled = !canWrite;
  if (!detail) {
    empty.hidden = false;
    conv.hidden = true;
    $("composer-lede").textContent = "Select a ticket to write back. Draft reply asks Workers AI after Turnstile; local and unusable-model paths show a labelled stub.";
    $("status").toggleAttribute("disabled", true);
    $("priority").toggleAttribute("disabled", true);
    $("assignee").toggleAttribute("disabled", true);
    return;
  }
  empty.hidden = true;
  conv.hidden = false;
  $("conv-number").textContent = `#${detail.number}`;
  $("conv-subject").textContent = detail.subject;
  $("conv-from").textContent = `${detail.customerName} · ${detail.customerEmail}`;
  fillSelect($("status") as HTMLSelectElement, STATUSES, detail.status);
  fillSelect($("priority") as HTMLSelectElement, PRIORITIES, detail.priority);
  fillSelect($("assignee") as HTMLSelectElement, ASSIGNEES, detail.assignee ?? "", { "": "Unassigned" });
  const seedLocked = !detail.sandbox;
  $("status").toggleAttribute("disabled", seedLocked);
  $("priority").toggleAttribute("disabled", seedLocked);
  $("assignee").toggleAttribute("disabled", seedLocked);
  renderFiles(detail.attachments);
  const ol = $("messages");
  ol.replaceChildren(
    ...detail.messages.map((m) => {
      const li = document.createElement("li");
      li.className = "msg";
      li.dataset.kind = m.authorKind;
      const via = m.via === "queue" ? " · via queue" : m.via === "seed" ? "" : ` · ${m.via}`;
      li.innerHTML = `<div class="msg__meta"><span></span><span class="mono"></span></div><div class="msg__body"></div>`;
      (li.querySelector(".msg__meta span") as HTMLElement).textContent = `${m.authorName}${via}`;
      (li.querySelector(".mono") as HTMLElement).textContent = relTime(m.createdAt);
      (li.querySelector(".msg__body") as HTMLElement).textContent = m.body;
      return li;
    }),
  );
  ol.scrollTop = ol.scrollHeight;
  $("composer-lede").textContent = `Reply to #${detail.number} as ${detail.assignee ?? "an unassigned agent"}.`;
}

async function selectTicket(id: string, opts: { user?: boolean; keepReply?: boolean } = {}) {
  const switching = state.selectedId !== id;
  const reply = $("reply") as HTMLTextAreaElement;
  const keep = opts.keepReply || (!opts.user && reply.value.trim().length > 0);
  const previous = keep ? reply.value : "";
  state.selectedId = id;
  renderList();
  try {
    state.detail = await api<TicketDetail>(`/tickets/${id}`);
    if (switching && !keep) reply.value = "";
    else if (keep) reply.value = previous;
    renderThread();
  } catch (err) {
    setHint(err instanceof ApiFailure ? err.message : "Could not load the ticket.", "error");
  }
}

function newestOwnQueueTicket(tickets: TicketSummary[]): TicketSummary | undefined {
  return tickets.find((t) => t.sandbox && t.lastVia === "queue");
}

function updateStrip(tickets: TicketSummary[]) {
  const strip = $("strip");
  const queued = newestOwnQueueTicket(tickets);
  if (state.awaitingTicketId) {
    strip.dataset.state = "queued";
    $("strip-text").textContent = "Inbound mail is on the Queue. Waiting for the consumer to write your sandbox…";
    return;
  }
  if (queued) {
    strip.dataset.state = "live";
    $("strip-text").textContent = `Last Queue ingest in this browser: #${queued.number} ${queued.subject} · ${relTime(queued.updatedAt)}`;
    return;
  }
  delete strip.dataset.state;
  $("strip-text").textContent = "Queue is idle. Simulate inbound mail to create a ticket that only this browser can see.";
}

async function refresh() {
  if (state.busy) return;
  state.busy = true;
  try {
    const { tickets } = await api<{ tickets: TicketSummary[] }>("/tickets");
    const prevSelected = state.tickets.find((t) => t.id === state.selectedId);
    const nextIds = new Set(tickets.map((t) => t.id));
    const awaitingTicket = state.awaitingTicketId;
    const awaitingMessage = state.awaitingMessageId;
    const nextSelected = tickets.find((t) => t.id === state.selectedId);
    const selectedChanged = Boolean(nextSelected && prevSelected && nextSelected.updatedAt !== prevSelected.updatedAt);

    if (awaitingTicket && awaitingMessage) {
      const created = tickets.find((t) => t.id === awaitingTicket);
      if (created) {
        try {
          const detail = await api<TicketDetail>(`/tickets/${awaitingTicket}`);
          if (detail.messages.some((m) => m.id === awaitingMessage)) {
            state.awaitingTicketId = null;
            state.awaitingMessageId = null;
            setHint(`Queue consumer wrote #${created.number}${created.sandbox ? " in this browser's sandbox" : ""}.`, "ok");
            state.tickets = tickets;
            state.knownIds = nextIds;
            state.detail = detail;
            state.selectedId = created.id;
            renderList();
            updateStrip(tickets);
            showThread();
            renderThread();
            return;
          }
        } catch {
          /* consumer has not written the message yet */
        }
      }
      state.tickets = tickets;
      state.knownIds = nextIds;
      renderList();
      updateStrip(tickets);
      return;
    }

    state.tickets = tickets;
    state.knownIds = nextIds;
    renderList();
    updateStrip(tickets);
    const onThread = !isPhone() || $("layout").dataset.view === "thread";
    if (selectedChanged && state.selectedId && onThread) {
      await selectTicket(state.selectedId, { keepReply: true });
    }
  } catch (err) {
    setHint(err instanceof ApiFailure ? err.message : "Could not refresh tickets.", "error");
  } finally {
    state.busy = false;
  }
}

async function waitForQueue() {
  updateStrip(state.tickets);
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 700));
    await refresh();
    if (!state.awaitingMessageId) return;
  }
  setHint("The Queue is still draining. The ticket should appear on the next refresh.", "error");
}

async function mintSession(): Promise<void> {
  const health = state.health;
  if (!health || health.session === "off") {
    throw new ApiFailure(503, "turnstile_unconfigured", "Writes are off until Turnstile is configured.");
  }
  const turnstileToken = await token("session");
  await api("/session", { method: "POST", body: turnstileToken ? { turnstileToken } : {} });
  sessionReady = true;
  if (state.siteKey && !state.testSiteKey) mountTurnstile("write");
}

async function ensureSession(): Promise<void> {
  if (sessionReady) return;
  if (sessionInflight) return sessionInflight;
  sessionInflight = mintSession().finally(() => {
    sessionInflight = null;
  });
  return sessionInflight;
}

function startPolling() {
  stopPolling();
  state.pollTimer = window.setInterval(() => {
    if (document.visibilityState === "hidden") return;
    void refresh();
  }, POLL_MS);
}

function stopPolling() {
  if (state.pollTimer) window.clearInterval(state.pollTimer);
  state.pollTimer = 0;
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
  showList();
});

for (const btn of document.querySelectorAll<HTMLButtonElement>(".filter")) {
  btn.addEventListener("click", () => {
    state.filter = btn.dataset.filter as typeof state.filter;
    document.querySelectorAll(".filter").forEach((b) => b.classList.toggle("is-on", b === btn));
    renderList();
  });
}

$("simulate").addEventListener("click", async () => {
  setHint("");
  try {
    await ensureSession();
    const turnstileToken = await token("write");
    const queued = await api<{ queued: boolean; ticketId: string; messageId: string }>("/inbound", {
      method: "POST",
      body: { turnstileToken },
    });
    state.awaitingTicketId = queued.ticketId;
    state.awaitingMessageId = queued.messageId;
    setHint("Queued a simulated customer email in this browser's sandbox.", "ok");
    await waitForQueue();
  } catch (err) {
    setHint(err instanceof ApiFailure ? err.message : err instanceof Error ? err.message : "Could not enqueue mail.", "error");
  }
});

$("customer-reply").addEventListener("click", async () => {
  if (!state.detail) return;
  setHint("");
  try {
    await ensureSession();
    const turnstileToken = await token("write");
    const queued = await api<{ queued: boolean; ticketId: string; messageId: string }>("/inbound", {
      method: "POST",
      body: {
        ticketId: state.detail.id,
        fromName: state.detail.customerName,
        fromEmail: state.detail.customerEmail,
        subject: `Re: [#${state.detail.number}] ${state.detail.subject}`.slice(0, 200),
        body: "Following up — any update on this? Happy to send more logs if you need them.",
        turnstileToken,
      },
    });
    state.awaitingTicketId = queued.ticketId;
    state.awaitingMessageId = queued.messageId;
    setHint("Queued a customer follow-up on this thread.", "ok");
    await waitForQueue();
    if (state.selectedId) await selectTicket(state.selectedId, { keepReply: true });
  } catch (err) {
    setHint(err instanceof ApiFailure ? err.message : err instanceof Error ? err.message : "Could not enqueue the reply.", "error");
  }
});

$("draft").addEventListener("click", async () => {
  if (!state.detail) return;
  setHint("Asking Workers AI for a draft…");
  setDraftPath(null);
  try {
    await ensureSession();
    const turnstileToken = await token("draft");
    const result = await api<DraftResult>(`/tickets/${state.detail.id}/draft`, { method: "POST", body: { turnstileToken } });
    ($("reply") as HTMLTextAreaElement).value = result.draft;
    setDraftPath(result.source, result.model);
    setHint(
      result.source === "fallback"
        ? `Stub draft (${result.model}). Workers AI did not return a usable body. Edit before you send.`
        : `Draft from ${result.model}. Edit before you send.`,
      "ok",
    );
    if (state.siteKey && !state.testSiteKey) mountTurnstile("write");
  } catch (err) {
    setHint(err instanceof ApiFailure ? err.message : err instanceof Error ? err.message : "Draft failed.", "error");
  }
});

$("send").addEventListener("click", async () => {
  if (!state.detail) return;
  const body = ($("reply") as HTMLTextAreaElement).value.trim();
  if (!body) {
    setHint("Write a reply first.", "error");
    return;
  }
  try {
    await ensureSession();
    state.detail = await api<TicketDetail>(`/tickets/${state.detail.id}/replies`, { method: "POST", body: { body } });
    ($("reply") as HTMLTextAreaElement).value = "";
    setHint("Reply saved on the thread.", "ok");
    await refresh();
    renderThread();
  } catch (err) {
    setHint(err instanceof ApiFailure ? err.message : "Could not send the reply.", "error");
  }
});

async function patchMeta() {
  if (!state.detail || !state.detail.sandbox) return;
  const status = ($("status") as HTMLSelectElement).value as TicketStatus;
  const priority = ($("priority") as HTMLSelectElement).value as TicketPriority;
  const assignee = ($("assignee") as HTMLSelectElement).value;
  try {
    await ensureSession();
    await api(`/tickets/${state.detail.id}`, { method: "PATCH", body: { status, priority, assignee: assignee || null } });
    await selectTicket(state.detail.id, { keepReply: true });
    await refresh();
  } catch (err) {
    setHint(err instanceof ApiFailure ? err.message : "Could not update the ticket.", "error");
  }
}

$("status").addEventListener("change", () => void patchMeta());
$("priority").addEventListener("change", () => void patchMeta());
$("assignee").addEventListener("change", () => void patchMeta());

$("upload").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.detail) return;
  const input = $("file") as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) {
    setHint("Choose a file first.", "error");
    return;
  }
  try {
    await ensureSession();
    const turnstileToken = await token("write");
    const form = new FormData();
    form.set("file", file);
    if (turnstileToken) form.set("turnstileToken", turnstileToken);
    await api(`/tickets/${state.detail.id}/attachments`, { method: "POST", form });
    input.value = "";
    setHint(`Stored ${file.name} in R2 for this browser. It is deleted after 24 hours.`, "ok");
    await selectTicket(state.detail.id, { keepReply: true });
  } catch (err) {
    setHint(err instanceof ApiFailure ? err.message : err instanceof Error ? err.message : "Upload failed.", "error");
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    void refresh();
    startPolling();
  } else {
    stopPolling();
  }
});

async function start() {
  try {
    const health = await api<Health>("/health");
    state.health = health;
    state.siteKey = health.siteKey ?? "";
    state.testSiteKey = health.testSiteKey;
    $("budget-note").textContent =
      health.session === "off"
        ? "Writes are off until Turnstile is configured."
        : `${health.budget.remaining} of ${health.budget.dailyCap} shared AI drafts left today${health.ai === "stub" ? " · local stub" : ""}.`;
    if (health.session === "off") {
      setHint("This slice is read-only until the owner sets TURNSTILE_SITE_KEY.", "error");
      await refresh();
      if (!isPhone() && state.tickets[0]) await selectTicket(state.tickets[0].id, { user: true });
      else showList();
      startPolling();
      return;
    }
    if (state.siteKey && !state.testSiteKey) mountTurnstile("session");
    await ensureSession();
    await refresh();
    if (!isPhone() && state.tickets[0]) await selectTicket(state.tickets[0].id, { user: true });
    else showList();
  } catch (err) {
    setHint(err instanceof ApiFailure ? err.message : err instanceof Error ? err.message : "Could not load tickets.", "error");
  }
  startPolling();
}

void start();
