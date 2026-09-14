import type { Attachment, TicketDetail, TicketPriority, TicketStatus, TicketSummary } from "../shared/types";

const API_BASE = location.pathname.startsWith("/demos/resolve-hq") ? "/demos/resolve-hq" : "";
const POLL_MS = 4000;
const STATUSES: TicketStatus[] = ["open", "pending", "resolved"];
const PRIORITIES: TicketPriority[] = ["low", "normal", "high", "urgent"];
const ASSIGNEES = ["", "Maya Chen", "Jordan Park"];

class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function api<T>(path: string, init: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  let body: BodyInit | undefined;
  if (init.form) body = init.form;
  else if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api${path}`, { method: init.method ?? "GET", headers, body });
  } catch {
    throw new ApiFailure(0, "network", "The network request failed.");
  }
  if (path.includes("/attachments/") && res.ok && init.method === undefined) return res as T;
  const data = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
  if (!res.ok) throw new ApiFailure(res.status, data?.error?.code ?? "http", data?.error?.message ?? `HTTP ${res.status}`);
  return data as T;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const state = {
  tickets: [] as TicketSummary[],
  filter: "all" as "all" | TicketStatus,
  selectedId: null as string | null,
  detail: null as TicketDetail | null,
  pollTimer: 0,
  awaitingQueue: false,
  knownIds: new Set<string>(),
};

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
      num.textContent = `#${t.number}`;
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
      btn.addEventListener("click", () => void selectTicket(t.id));
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
    $("composer-lede").textContent = "Select a ticket to write back. Draft reply asks Workers AI; it fails soft if the model is down.";
    return;
  }
  empty.hidden = true;
  conv.hidden = false;
  $("layout").dataset.view = "thread";
  $("conv-number").textContent = `#${detail.number}`;
  $("conv-subject").textContent = detail.subject;
  $("conv-from").textContent = `${detail.customerName} · ${detail.customerEmail}`;
  fillSelect($("status") as HTMLSelectElement, STATUSES, detail.status);
  fillSelect($("priority") as HTMLSelectElement, PRIORITIES, detail.priority);
  fillSelect($("assignee") as HTMLSelectElement, ASSIGNEES, detail.assignee ?? "", { "": "Unassigned" });
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

async function selectTicket(id: string) {
  const switching = state.selectedId !== id;
  state.selectedId = id;
  renderList();
  try {
    state.detail = await api<TicketDetail>(`/tickets/${id}`);
    if (switching) ($("reply") as HTMLTextAreaElement).value = "";
    renderThread();
  } catch (err) {
    setHint(err instanceof ApiFailure ? err.message : "Could not load the ticket.", "error");
  }
}

function newestQueueTicket(tickets: TicketSummary[]): TicketSummary | undefined {
  return tickets.find((t) => t.lastVia === "queue");
}

function updateStrip(tickets: TicketSummary[]) {
  const strip = $("strip");
  const queued = newestQueueTicket(tickets);
  if (state.awaitingQueue) {
    strip.dataset.state = "queued";
    $("strip-text").textContent = "Inbound mail is on the Queue. Waiting for the consumer to write D1…";
    return;
  }
  if (queued) {
    strip.dataset.state = "live";
    $("strip-text").textContent = `Last Queue ingest: #${queued.number} ${queued.subject} · ${relTime(queued.updatedAt)}`;
    return;
  }
  delete strip.dataset.state;
  $("strip-text").textContent = "Queue is idle. Simulate inbound mail to create a ticket through the consumer.";
}

async function refresh() {
  const { tickets } = await api<{ tickets: TicketSummary[] }>("/tickets");
  const prev = state.knownIds;
  const prevSelected = state.tickets.find((t) => t.id === state.selectedId);
  const nextIds = new Set(tickets.map((t) => t.id));
  const created = tickets.find((t) => !prev.has(t.id) && t.lastVia === "queue");
  const nextSelected = tickets.find((t) => t.id === state.selectedId);
  const selectedChanged = Boolean(nextSelected && prevSelected && nextSelected.updatedAt !== prevSelected.updatedAt);

  if (prev.size && created) {
    state.awaitingQueue = false;
    setHint(`Queue consumer created #${created.number}.`, "ok");
    state.tickets = tickets;
    state.knownIds = nextIds;
    renderList();
    updateStrip(tickets);
    await selectTicket(created.id);
    return;
  }
  if (state.awaitingQueue && selectedChanged && nextSelected?.lastVia === "queue") {
    state.awaitingQueue = false;
    setHint("Queue consumer appended a customer message.", "ok");
  }

  state.tickets = tickets;
  state.knownIds = nextIds;
  renderList();
  updateStrip(tickets);
  if (selectedChanged && state.selectedId) {
    const keep = ($("reply") as HTMLTextAreaElement).value;
    await selectTicket(state.selectedId);
    ($("reply") as HTMLTextAreaElement).value = keep;
  }
}

async function waitForQueue() {
  state.awaitingQueue = true;
  updateStrip(state.tickets);
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 700));
    await refresh();
    if (!state.awaitingQueue) return;
  }
  state.awaitingQueue = false;
  updateStrip(state.tickets);
  setHint("The Queue is still draining. The ticket should appear on the next refresh.", "error");
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
  $("layout").dataset.view = "list";
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
    await api("/inbound", { method: "POST", body: {} });
    setHint("Queued a simulated customer email.", "ok");
    await waitForQueue();
  } catch (err) {
    setHint(err instanceof ApiFailure ? err.message : "Could not enqueue mail.", "error");
  }
});

$("customer-reply").addEventListener("click", async () => {
  if (!state.detail) return;
  setHint("");
  try {
    await api("/inbound", {
      method: "POST",
      body: {
        ticketId: state.detail.id,
        fromName: state.detail.customerName,
        fromEmail: state.detail.customerEmail,
        subject: `Re: [#${state.detail.number}] ${state.detail.subject}`,
        body: "Following up — any update on this? Happy to send more logs if you need them.",
      },
    });
    setHint("Queued a customer follow-up on this thread.", "ok");
    await waitForQueue();
    if (state.selectedId) await selectTicket(state.selectedId);
  } catch (err) {
    setHint(err instanceof ApiFailure ? err.message : "Could not enqueue the reply.", "error");
  }
});

$("draft").addEventListener("click", async () => {
  if (!state.detail) return;
  setHint("Asking Workers AI for a draft…");
  try {
    const result = await api<{ draft: string; model: string }>(`/tickets/${state.detail.id}/draft`, { method: "POST" });
    ($("reply") as HTMLTextAreaElement).value = result.draft;
    setHint(`Draft from ${result.model}. Edit before you send.`, "ok");
  } catch (err) {
    setHint(err instanceof ApiFailure ? err.message : "Draft failed.", "error");
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
  if (!state.detail) return;
  const status = ($("status") as HTMLSelectElement).value as TicketStatus;
  const priority = ($("priority") as HTMLSelectElement).value as TicketPriority;
  const assignee = ($("assignee") as HTMLSelectElement).value;
  try {
    await api(`/tickets/${state.detail.id}`, { method: "PATCH", body: { status, priority, assignee: assignee || null } });
    await selectTicket(state.detail.id);
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
  const form = new FormData();
  form.set("file", file);
  try {
    await api(`/tickets/${state.detail.id}/attachments`, { method: "POST", form });
    input.value = "";
    setHint(`Stored ${file.name} in R2.`, "ok");
    await selectTicket(state.detail.id);
  } catch (err) {
    setHint(err instanceof ApiFailure ? err.message : "Upload failed.", "error");
  }
});

async function start() {
  try {
    await refresh();
    if (state.tickets[0]) await selectTicket(state.tickets[0].id);
  } catch (err) {
    setHint(err instanceof ApiFailure ? err.message : "Could not load tickets.", "error");
  }
  state.pollTimer = window.setInterval(() => void refresh(), POLL_MS);
}

void start();
