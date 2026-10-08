import type { ApiError, AppConfig, ChatMessage, ChatResult, CreatedOrg, MemoryItem, OrgView } from "../shared/types";

const ORG_KEY = "company-brain-org";
const INGEST_KEY = "company-brain-ingest";

type TurnstileApi = {
  render: (el: HTMLElement, opts: { sitekey: string; action?: string; callback?: (token: string) => void }) => string;
  getResponse: (id?: string) => string | undefined;
  reset: (id?: string) => void;
  remove: (id: string) => void;
};

function $(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node;
}

function apiRoot(): string {
  const path = location.pathname;
  const marker = "/demos/company-brain";
  if (path === marker || path.startsWith(`${marker}/`)) return marker;
  return "";
}

function turnstileApi(): TurnstileApi | undefined {
  const candidate = (window as Window & { turnstile?: TurnstileApi }).turnstile;
  if (!candidate || typeof candidate.render !== "function" || typeof candidate.getResponse !== "function") return undefined;
  return candidate;
}

async function waitForTurnstile(): Promise<TurnstileApi | undefined> {
  const started = Date.now();
  while (Date.now() - started < 8000) {
    const api = turnstileApi();
    if (api) return api;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return turnstileApi();
}

async function call<T>(path: string, init: { method?: string; body?: unknown; ingest?: string } = {}): Promise<{ status: number; data: T | ApiError | null }> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.ingest) headers["x-ingest-token"] = init.ingest;
  const res = await fetch(`${apiRoot()}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: "include",
  });
  const data = (await res.json().catch(() => null)) as T | ApiError | null;
  return { status: res.status, data };
}

function isError(data: unknown): data is ApiError {
  if (!data || typeof data !== "object" || !("error" in data)) return false;
  const error = (data as ApiError).error;
  return Boolean(error && typeof error.message === "string");
}

function messageOf(data: unknown, fallback: string): string {
  return isError(data) ? data.error.message : fallback;
}

function when(ms: number): string {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(ms);
}

const gate = $("gate");
const workspace = $("workspace");
const stripText = $("strip-text");
const gateError = $("gate-error");
const chatError = $("chat-error");
const addError = $("add-error");
const log = $("log");
const facts = $("facts");
const decisions = $("decisions");
const counts = $("counts");
const tokenBox = $("token");
const tokenValue = $("token-value") as HTMLInputElement;
const question = $("question") as HTMLTextAreaElement;
const createBtn = $("create") as HTMLButtonElement;
const sendBtn = $("send") as HTMLButtonElement;

let config: AppConfig | null = null;
let org: OrgView | null = null;
let gateWidget: string | null = null;
let chatWidget: string | null = null;

function renderCard(item: MemoryItem): HTMLLIElement {
  const li = document.createElement("li");
  li.className = item.kind === "decision" ? "card card--decision" : "card";
  const text = document.createElement("p");
  text.textContent = item.text;
  const meta = document.createElement("p");
  meta.className = "card__meta";
  const id = document.createElement("code");
  id.textContent = item.id;
  meta.append(id, ` · ${item.author} · ${item.source}`);
  li.append(text, meta);
  return li;
}

function renderCite(source: ChatMessage["sources"][number]): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "cite";
  const id = document.createElement("code");
  id.textContent = `[${source.kind}:${source.id}]`;
  li.append(id, ` ${source.snippet}`);
  return li;
}

function renderMessage(message: ChatMessage): HTMLLIElement {
  const li = document.createElement("li");
  const unknown = message.role === "assistant" && message.text === "I don't know.";
  li.className = `bubble bubble--${message.role}${unknown ? " bubble--unknown" : ""}`;
  const text = document.createElement("p");
  text.textContent = message.text;
  li.append(text);
  if (message.sources.length) {
    const list = document.createElement("ul");
    list.className = "cites";
    for (const source of message.sources) list.append(renderCite(source));
    li.append(list);
  }
  return li;
}

function paint(): void {
  if (!org) return;
  facts.replaceChildren(...org.facts.map(renderCard));
  decisions.replaceChildren(...org.decisions.map(renderCard));
  log.replaceChildren(...org.messages.map(renderMessage));
  log.scrollTop = log.scrollHeight;
  counts.textContent = `${org.facts.length} facts · ${org.decisions.length} decisions`;
  stripText.textContent = `Sandbox ${org.id.slice(0, 12)}… expires ${when(org.expiresAt)}. A Durable Object alarm wipes it.`;
}

function showIngest(token: string | null): void {
  if (!token) {
    tokenBox.hidden = true;
    tokenValue.value = "";
    return;
  }
  tokenBox.hidden = false;
  tokenValue.value = token;
}

async function mountWidget(el: HTMLElement, current: string | null, onToken: () => void): Promise<string | null> {
  if (!config?.turnstileSiteKey) return null;
  const api = await waitForTurnstile();
  if (!api) return null;
  if (current) api.remove(current);
  // The callback fires again after reset(), so the button stays disabled until a fresh token exists.
  return api.render(el, { sitekey: config.turnstileSiteKey, action: "company-brain", callback: () => onToken() });
}

function widgetToken(id: string | null): string {
  if (!id) return "";
  return turnstileApi()?.getResponse(id) || "";
}

async function refresh(orgId: string): Promise<boolean> {
  const res = await call<OrgView>(`/api/orgs/${orgId}`);
  if (res.status === 200 && res.data && "facts" in res.data) {
    org = res.data;
    gate.hidden = true;
    workspace.hidden = false;
    paint();
    return true;
  }
  sessionStorage.removeItem(ORG_KEY);
  sessionStorage.removeItem(INGEST_KEY);
  org = null;
  gate.hidden = false;
  workspace.hidden = true;
  gateError.textContent = messageOf(res.data, "This sandbox is gone. Create another.");
  return false;
}

async function boot(): Promise<void> {
  const configRes = await call<AppConfig>("/api/config");
  if (configRes.status === 200 && configRes.data && "turnstileSiteKey" in configRes.data) config = configRes.data;
  createBtn.disabled = true;
  gateWidget = await mountWidget($("gate-turnstile"), null, () => {
    createBtn.disabled = false;
  });
  if (!gateWidget) createBtn.disabled = false;
  const saved = sessionStorage.getItem(ORG_KEY);
  if (saved && (await refresh(saved))) {
    showIngest(sessionStorage.getItem(INGEST_KEY));
    sendBtn.disabled = true;
    chatWidget = await mountWidget($("chat-turnstile"), null, () => {
      sendBtn.disabled = false;
    });
    if (!chatWidget) sendBtn.disabled = false;
  }
}

createBtn.addEventListener("click", async () => {
  gateError.textContent = "";
  const turnstileToken = widgetToken(gateWidget);
  if (!turnstileToken) {
    gateError.textContent = "Complete the Turnstile check, then create the org.";
    return;
  }
  createBtn.disabled = true;
  const res = await call<CreatedOrg>("/api/orgs", { method: "POST", body: { turnstileToken } });
  createBtn.disabled = false;
  turnstileApi()?.reset(gateWidget ?? undefined);
  if (res.status !== 201 || !res.data || !("sessionToken" in res.data)) {
    gateError.textContent = messageOf(res.data, "Could not create the org.");
    return;
  }
  sessionStorage.setItem(ORG_KEY, res.data.id);
  sessionStorage.setItem(INGEST_KEY, res.data.ingestToken);
  org = res.data;
  gate.hidden = true;
  workspace.hidden = false;
  showIngest(res.data.ingestToken);
  paint();
  sendBtn.disabled = true;
  chatWidget = await mountWidget($("chat-turnstile"), chatWidget, () => {
    sendBtn.disabled = false;
  });
  if (!chatWidget) sendBtn.disabled = false;
  question.focus();
});

document.querySelectorAll<HTMLButtonElement>("[data-ask]").forEach((button) => {
  button.addEventListener("click", () => {
    question.value = button.dataset.ask ?? "";
    question.focus();
  });
});

$("composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  chatError.textContent = "";
  if (!org) return;
  const message = question.value.trim();
  if (!message) return;
  const turnstileToken = widgetToken(chatWidget);
  if (!turnstileToken) {
    chatError.textContent = "Complete the Turnstile check, then ask.";
    return;
  }
  sendBtn.disabled = true;
  const res = await call<ChatResult>(`/api/orgs/${org.id}/chat`, { method: "POST", body: { message, turnstileToken } });
  turnstileApi()?.reset(chatWidget ?? undefined);
  if (res.status !== 200 || !res.data || !("answer" in res.data)) {
    chatError.textContent = messageOf(res.data, "The question did not go through.");
    return;
  }
  question.value = "";
  await refresh(org.id);
});

$("add").addEventListener("submit", async (event) => {
  event.preventDefault();
  addError.textContent = "";
  if (!org) return;
  const kind = ($("add-kind") as HTMLSelectElement).value === "decision" ? "decision" : "fact";
  const text = ($("add-text") as HTMLTextAreaElement).value.trim();
  const author = ($("add-author") as HTMLInputElement).value.trim();
  const source = ($("add-source") as HTMLInputElement).value.trim();
  if (!text) return;
  const button = $("add-btn") as HTMLButtonElement;
  button.disabled = true;
  const res = await call<{ item: MemoryItem }>(`/api/orgs/${org.id}/${kind === "decision" ? "decisions" : "facts"}`, {
    method: "POST",
    body: { text, author: author || undefined, source: source || undefined },
  });
  button.disabled = false;
  if (res.status !== 201) {
    addError.textContent = messageOf(res.data, "Could not save that.");
    return;
  }
  ($("add-text") as HTMLTextAreaElement).value = "";
  await refresh(org.id);
});

$("token-copy").addEventListener("click", async () => {
  const value = tokenValue.value;
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    stripText.textContent = "Ingest token copied.";
  } catch {
    tokenValue.type = "text";
    tokenValue.select();
  }
});

$("token-dismiss").addEventListener("click", () => {
  sessionStorage.removeItem(INGEST_KEY);
  showIngest(null);
});

void boot().catch(() => {
  gateError.textContent = "The page could not reach the Worker.";
});
