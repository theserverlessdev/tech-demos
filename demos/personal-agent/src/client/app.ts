import type { ChatReply, ConfigResponse, NoteDetail, NoteSummary, ResearchReply, SessionInfo, ThreadMessage } from "../shared/types";

const API_BASE = location.pathname.startsWith("/demos/personal-agent") ? "/demos/personal-agent" : "";
const VISITOR_KEY = "personal-agent-visitor";
const VISITOR_RE = /^[a-z0-9]{16,32}$/;
const DUMMY_READY = "personal-agent";

type TurnstileApi = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  reset: (id?: string) => void;
  getResponse: (id?: string) => string | undefined;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function visitorId(): string {
  const current = localStorage.getItem(VISITOR_KEY) ?? "";
  if (VISITOR_RE.test(current)) return current;
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const next = [...bytes].map((byte) => alphabet[byte % 36]).join("");
  localStorage.setItem(VISITOR_KEY, next);
  return next;
}

let visitor = visitorId();
let turnstileId = "";
let openNote: NoteDetail | null = null;
let deleteArmed = false;

function hint(text: string, tone: "ok" | "error" | "" = "") {
  const node = $("hint");
  node.textContent = text;
  if (tone) node.dataset.tone = tone;
  else delete node.dataset.tone;
}

async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { method: init.method ?? "GET", headers, body });
  } catch {
    throw new ApiFailure(0, "network", "The network request failed.");
  }
  const data = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
  if (!res.ok) throw new ApiFailure(res.status, data?.error?.code ?? "http", data?.error?.message ?? `HTTP ${res.status}`);
  return data as T;
}

function token(): string {
  if (!turnstileId || !window.turnstile) return "";
  return window.turnstile.getResponse(turnstileId) ?? "";
}

function resetCheck() {
  if (turnstileId && window.turnstile) window.turnstile.reset(turnstileId);
}

function renderMessages(messages: ThreadMessage[]) {
  const list = $("messages");
  list.replaceChildren();
  $("empty").hidden = messages.length > 0;
  for (const message of messages) {
    const item = el("li", "message");
    item.dataset.role = message.role;
    const text = el("p");
    text.textContent = message.content;
    item.append(text);
    if (message.recalled.length) {
      const recalls = el("div", "recalls");
      for (const hit of message.recalled) {
        const chip = el("span", "recall");
        chip.dataset.recallTitle = hit.title;
        chip.textContent = `${hit.title} · ${hit.score.toFixed(2)}`;
        recalls.append(chip);
      }
      item.append(recalls);
    }
    list.append(item);
  }
  list.scrollTop = list.scrollHeight;
}

function renderNotes(notes: NoteSummary[]) {
  $("note-count").textContent = String(notes.length);
  const list = $("note-list");
  list.replaceChildren();
  for (const note of notes) {
    const item = el("li");
    const button = el("button", "note");
    button.type = "button";
    button.textContent = note.title;
    if (openNote?.id === note.id) button.classList.add("is-on");
    button.addEventListener("click", () => void open(note.id));
    item.append(button);
    list.append(item);
  }
}

function showNote(note: NoteDetail | null) {
  openNote = note;
  deleteArmed = false;
  const viewer = $("viewer");
  const button = $<HTMLButtonElement>("delete-note");
  button.textContent = "Delete";
  if (!note) {
    viewer.hidden = true;
    return;
  }
  viewer.hidden = false;
  $("viewer-title").textContent = note.title;
  $("viewer-body").textContent = note.body;
}

async function refresh() {
  const [session, thread, notes] = await Promise.all([
    api<SessionInfo>(`/api/session?visitorId=${visitor}`),
    api<{ messages: ThreadMessage[] }>(`/api/thread?visitorId=${visitor}`),
    api<{ notes: NoteSummary[] }>(`/api/notes?visitorId=${visitor}`),
  ]);
  const when = session.expiresAt ? new Date(session.expiresAt).toLocaleString() : "the first write";
  $("strip-text").textContent = `Visitor ${visitor.slice(0, 6)}… · notes and chat expire ${session.ttlHours}h after the last write (${when}).`;
  renderMessages(thread.messages);
  renderNotes(notes.notes);
  if (openNote && !notes.notes.some((note) => note.id === openNote?.id)) showNote(null);
}

async function open(id: string) {
  const note = await api<NoteDetail>(`/api/notes/${id}?visitorId=${visitor}`);
  showNote(note);
  const notes = await api<{ notes: NoteSummary[] }>(`/api/notes?visitorId=${visitor}`);
  renderNotes(notes.notes);
}

async function waitForTurnstile(): Promise<TurnstileApi | null> {
  const started = Date.now();
  while (Date.now() - started < 8_000) {
    if (window.turnstile) return window.turnstile;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

async function mountTurnstile(siteKey: string) {
  if (!siteKey) {
    hint("Turnstile site key is not set. Chat stays closed until it is configured.", "error");
    $<HTMLButtonElement>("send").disabled = true;
    $<HTMLButtonElement>("save-note").disabled = true;
    $<HTMLButtonElement>("research").disabled = true;
    return;
  }
  const apiWidget = await waitForTurnstile();
  if (!apiWidget) {
    hint("The Turnstile script did not load.", "error");
    return;
  }
  turnstileId = apiWidget.render($("turnstile"), {
    sitekey: siteKey,
    action: DUMMY_READY,
    theme: document.documentElement.dataset.theme === "light" ? "light" : "dark",
  });
}

$("theme").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("theme", next);
});

$("new-visitor").addEventListener("click", () => {
  localStorage.removeItem(VISITOR_KEY);
  location.reload();
});

$("composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = $<HTMLTextAreaElement>("message").value.trim();
  if (!message) return;
  const turnstileToken = token();
  if (!turnstileToken) {
    hint("Complete the Turnstile check first.", "error");
    return;
  }
  const button = $<HTMLButtonElement>("send");
  button.disabled = true;
  hint("Asking the assistant…");
  try {
    const reply = await api<ChatReply>("/api/chat", { method: "POST", body: { visitorId: visitor, message, turnstileToken } });
    $<HTMLTextAreaElement>("message").value = "";
    hint(reply.source === "workers-ai" ? "Reply from Workers AI." : "Reply from the local fallback. Workers AI did not answer.", reply.source === "workers-ai" ? "ok" : "");
    resetCheck();
    await refresh();
  } catch (err) {
    hint(err instanceof ApiFailure ? err.message : "The send failed.", "error");
    resetCheck();
  } finally {
    button.disabled = false;
  }
});

$("note-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const title = $<HTMLInputElement>("note-title").value.trim();
  const body = $<HTMLTextAreaElement>("note-body").value.trim();
  const turnstileToken = token();
  if (!turnstileToken) {
    hint("Complete the Turnstile check first.", "error");
    return;
  }
  const button = $<HTMLButtonElement>("save-note");
  button.disabled = true;
  try {
    await api<{ note: NoteSummary }>("/api/notes", { method: "POST", body: { visitorId: visitor, title, body, turnstileToken } });
    $<HTMLInputElement>("note-title").value = "";
    $<HTMLTextAreaElement>("note-body").value = "";
    hint("Note saved in R2.", "ok");
    resetCheck();
    await refresh();
  } catch (err) {
    hint(err instanceof ApiFailure ? err.message : "The note could not be saved.", "error");
    resetCheck();
  } finally {
    button.disabled = false;
  }
});

$("delete-note").addEventListener("click", async () => {
  if (!openNote) return;
  if (!deleteArmed) {
    deleteArmed = true;
    $<HTMLButtonElement>("delete-note").textContent = "Confirm delete";
    return;
  }
  const turnstileToken = token();
  if (!turnstileToken) {
    hint("Complete the Turnstile check first.", "error");
    return;
  }
  try {
    await api<{ deleted: true }>(`/api/notes/${openNote.id}`, {
      method: "DELETE",
      body: { visitorId: visitor, turnstileToken },
    });
    showNote(null);
    hint("Note deleted.", "ok");
    resetCheck();
    await refresh();
  } catch (err) {
    hint(err instanceof ApiFailure ? err.message : "The note could not be deleted.", "error");
    resetCheck();
  }
});

$("research-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = $<HTMLTextAreaElement>("question").value.trim();
  const urls = $<HTMLTextAreaElement>("urls").value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const turnstileToken = token();
  if (!turnstileToken) {
    hint("Complete the Turnstile check first.", "error");
    return;
  }
  const button = $<HTMLButtonElement>("research");
  button.disabled = true;
  hint("Fetching pages…");
  try {
    const body: { visitorId: string; question: string; turnstileToken: string; urls?: string[] } = {
      visitorId: visitor,
      question,
      turnstileToken,
    };
    if (urls.length) body.urls = urls;
    const report = await api<ResearchReply>("/api/research", { method: "POST", body });
    $("report").hidden = false;
    $("report-source").textContent = report.source === "workers-ai" ? "Workers AI summary" : "Excerpt fallback";
    $("report-summary").textContent = report.summary;
    const cites = $("report-cites");
    cites.replaceChildren();
    for (const cite of report.citations) {
      const item = el("li");
      if (cite.ok) {
        const link = el("a");
        link.href = cite.url;
        link.rel = "noopener";
        link.target = "_blank";
        link.textContent = cite.title || cite.url;
        item.append(link);
      } else {
        item.className = "cite-bad";
        item.textContent = `${cite.url} — ${cite.error ?? "failed"}`;
      }
      cites.append(item);
    }
    hint("Research finished.", "ok");
    resetCheck();
    await refresh();
  } catch (err) {
    hint(err instanceof ApiFailure ? err.message : "Research failed.", "error");
    resetCheck();
  } finally {
    button.disabled = false;
  }
});

const config = await api<ConfigResponse>("/api/config");
await mountTurnstile(config.siteKey);
try {
  await refresh();
} catch (err) {
  hint(err instanceof ApiFailure ? err.message : "The notebook could not be loaded.", "error");
}
