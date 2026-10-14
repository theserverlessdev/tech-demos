import { KEY_HEADER } from "../shared/limits";
import type { CapabilityResult, PublicConfig, SideMetrics } from "../shared/types";

const SESSION_STORE = "byok.session";
const LOCAL_STORE = "byok.local";
const REMEMBER_STORE = "byok.remember";

type Creds = { key: string; baseUrl: string; model: string };
type ApiError = { error?: { code?: string; message?: string } };

const $ = <T extends HTMLElement>(id: string) => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
};

const apiKey = $<HTMLInputElement>("api-key");
const baseUrl = $<HTMLInputElement>("base-url");
const model = $<HTMLInputElement>("model");
const remember = $<HTMLInputElement>("remember");
const clearKey = $<HTMLButtonElement>("clear-key");
const listModels = $<HTMLButtonElement>("list-models");
const modelsNote = $<HTMLParagraphElement>("models-note");
const modelList = $<HTMLDataListElement>("model-list");
const system = $<HTMLTextAreaElement>("system");
const temperature = $<HTMLInputElement>("temperature");
const maxTokens = $<HTMLInputElement>("max-tokens");
const tempOut = $<HTMLOutputElement>("temp-out");
const tokensOut = $<HTMLOutputElement>("tokens-out");
const transcript = $<HTMLOListElement>("transcript");
const composer = $<HTMLFormElement>("composer");
const prompt = $<HTMLTextAreaElement>("prompt");
const send = $<HTMLButtonElement>("send");
const compareBtn = $<HTMLButtonElement>("compare");
const budgetNote = $<HTMLParagraphElement>("budget-note");
const yoursMetrics = $<HTMLParagraphElement>("yours-metrics");
const oursMetrics = $<HTMLParagraphElement>("ours-metrics");
const yoursOut = $<HTMLPreElement>("yours-out");
const oursOut = $<HTMLPreElement>("ours-out");
const runCaps = $<HTMLButtonElement>("run-caps");
const caps = $<HTMLUListElement>("caps");
const status = $<HTMLParagraphElement>("status");
const turnstileHost = $<HTMLDivElement>("turnstile");
const themeBtn = $<HTMLButtonElement>("theme");

let siteKey = "";
let testSiteKey = false;
let widgetId: string | null = null;
let readyToken: string | null = null;
let tokenWaiter: ((token: string) => void) | null = null;
let busy = false;

function api(path: string): string {
  const url = new URL(location.href);
  const dir = url.pathname.endsWith("/") ? url.pathname : url.pathname.replace(/[^/]+$/, "");
  return `${dir}${path.replace(/^\//, "")}`;
}

function say(message: string) {
  status.textContent = message;
}

function loadCreds(): Creds {
  remember.checked = localStorage.getItem(REMEMBER_STORE) === "1";
  const raw = remember.checked ? localStorage.getItem(LOCAL_STORE) : sessionStorage.getItem(SESSION_STORE);
  if (!raw) return { key: "", baseUrl: "https://api.openai.com/v1", model: "" };
  try {
    const parsed = JSON.parse(raw) as Creds;
    return {
      key: typeof parsed.key === "string" ? parsed.key : "",
      baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : "https://api.openai.com/v1",
      model: typeof parsed.model === "string" ? parsed.model : "",
    };
  } catch {
    return { key: "", baseUrl: "https://api.openai.com/v1", model: "" };
  }
}

function saveCreds() {
  const payload = JSON.stringify({ key: apiKey.value, baseUrl: baseUrl.value, model: model.value });
  sessionStorage.setItem(SESSION_STORE, payload);
  if (remember.checked) {
    localStorage.setItem(REMEMBER_STORE, "1");
    localStorage.setItem(LOCAL_STORE, payload);
  } else {
    localStorage.removeItem(REMEMBER_STORE);
    localStorage.removeItem(LOCAL_STORE);
  }
}

function applyCreds(creds: Creds) {
  apiKey.value = creds.key;
  baseUrl.value = creds.baseUrl;
  model.value = creds.model;
}

function credentials(): Creds {
  return { key: apiKey.value.trim(), baseUrl: baseUrl.value.trim(), model: model.value.trim() };
}

function requireEndpoint(): Creds {
  const creds = credentials();
  if (!creds.key) throw new Error("Paste an API key. It stays in this browser.");
  if (!creds.baseUrl) throw new Error("Enter an https base URL.");
  return creds;
}

function requireCreds(): Creds {
  const creds = requireEndpoint();
  if (!creds.model) throw new Error("Enter a model id.");
  return creds;
}

async function call(path: string, init: { method?: string; body?: unknown; key?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  if (init.key) headers[KEY_HEADER] = init.key;
  return fetch(api(path), { method: init.method ?? "GET", headers, body, credentials: "same-origin" });
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

function addBubble(role: "user" | "assistant", text: string): HTMLElement {
  const item = document.createElement("li");
  item.className = `bubble ${role}`;
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = role === "user" ? "You" : "Model";
  const body = document.createElement("div");
  body.textContent = text;
  item.append(who, body);
  transcript.append(item);
  item.scrollIntoView({ block: "end" });
  return body;
}

function chatBody(creds: Creds, extra: Record<string, unknown> = {}) {
  const history = [...transcript.querySelectorAll(".bubble")].map((node) => {
    const role = node.classList.contains("user") ? "user" : "assistant";
    const content = node.querySelector("div")?.textContent ?? "";
    return { role, content };
  });
  if (!history.length || extra.prompt) {
    const content = typeof extra.prompt === "string" ? extra.prompt : prompt.value.trim();
    if (content) history.push({ role: "user", content });
  }
  return {
    baseUrl: creds.baseUrl,
    model: creds.model,
    system: system.value,
    temperature: Number(temperature.value),
    max_tokens: Number(maxTokens.value),
    messages: history.filter((row) => row.content),
    ...extra,
  };
}

async function readSseChat(res: Response, target: HTMLElement) {
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let carry = "";
  let text = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    carry += decoder.decode(chunk.value, { stream: true });
    const lines = carry.split(/\r?\n/);
    carry = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const parsed = JSON.parse(payload) as { choices?: { delta?: { content?: string }; message?: { content?: string } }[] };
        const piece = parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content ?? "";
        if (piece) {
          text += piece;
          target.textContent = text;
        }
      } catch {
        /* ignore */
      }
    }
  }
}

async function sendChat(event: Event) {
  event.preventDefault();
  if (busy) return;
  let creds: Creds;
  try {
    creds = requireCreds();
  } catch (err) {
    say(err instanceof Error ? err.message : "Missing credentials.");
    return;
  }
  const text = prompt.value.trim();
  if (!text) return;
  saveCreds();
  addBubble("user", text);
  prompt.value = "";
  const reply = addBubble("assistant", "");
  busy = true;
  send.disabled = true;
  say("");
  try {
    const res = await call("api/proxy/chat/stream", { method: "POST", key: creds.key, body: chatBody(creds, { messages: [{ role: "user", content: text }] }) });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as unknown;
      reply.textContent = messageOf(data, "The endpoint returned an error.");
      say(reply.textContent);
      return;
    }
    await readSseChat(res, reply);
    if (!reply.textContent) reply.textContent = "(empty reply)";
  } catch (err) {
    reply.textContent = err instanceof Error ? err.message : "The chat request failed.";
    say(reply.textContent);
  } finally {
    busy = false;
    send.disabled = false;
  }
}

async function loadModels() {
  let creds: Creds;
  try {
    creds = requireEndpoint();
  } catch (err) {
    say(err instanceof Error ? err.message : "Missing credentials.");
    return;
  }
  saveCreds();
  modelsNote.textContent = "Listing models…";
  try {
    const res = await call("api/proxy/models", { method: "POST", key: creds.key, body: { baseUrl: creds.baseUrl } });
    const data = (await res.json().catch(() => null)) as { data?: { id?: string }[]; error?: { message?: string } } | null;
    if (!res.ok) {
      modelsNote.textContent = messageOf(data, "Could not list models.");
      return;
    }
    const ids = (data?.data ?? []).map((row) => row.id).filter((id): id is string => Boolean(id));
    modelList.replaceChildren();
    for (const id of ids.slice(0, 80)) {
      const option = document.createElement("option");
      option.value = id;
      modelList.append(option);
    }
    modelsNote.textContent = ids.length ? `${ids.length} models. Pick one from the list.` : "The endpoint returned no model ids.";
  } catch (err) {
    modelsNote.textContent = err instanceof Error ? err.message : "Could not list models.";
  }
}

function setMetrics(node: HTMLElement, side: SideMetrics | null) {
  if (!side) {
    node.textContent = "Latency · TTFT · tokens";
    return;
  }
  const ttft = side.ttftMs === null ? "—" : `${side.ttftMs} ms`;
  const tokens = side.tokens === null ? "—" : String(side.tokens);
  node.textContent = `${side.latencyMs} ms · TTFT ${ttft} · tokens ${tokens} · ${side.source}`;
}

async function runCompare() {
  if (busy) return;
  let creds: Creds;
  try {
    creds = requireCreds();
  } catch (err) {
    say(err instanceof Error ? err.message : "Missing credentials.");
    return;
  }
  const text = prompt.value.trim() || "Reply with one short sentence about edge workers.";
  saveCreds();
  busy = true;
  compareBtn.disabled = true;
  say("");
  yoursOut.textContent = "";
  oursOut.textContent = "";
  setMetrics(yoursMetrics, null);
  setMetrics(oursMetrics, null);
  try {
    const token = testSiteKey || !siteKey ? TURNSTILE_DUMMY : await takeToken();
    const res = await call("api/compare", {
      method: "POST",
      key: creds.key,
      body: {
        ...chatBody(creds, { messages: [{ role: "user", content: text }] }),
        turnstileToken: token,
        max_tokens: Math.min(Number(maxTokens.value), 128),
      },
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as unknown;
      say(messageOf(data, "Compare failed."));
      return;
    }
    const reader = res.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let carry = "";
    let eventName = "message";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      carry += decoder.decode(chunk.value, { stream: true });
      const lines = carry.split(/\r?\n/);
      carry = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
          continue;
        }
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        const parsed = JSON.parse(payload) as SideMetrics;
        if (eventName === "yours" || parsed.side === "yours") {
          yoursOut.textContent = parsed.error || parsed.text;
          setMetrics(yoursMetrics, parsed);
        }
        if (eventName === "ours" || parsed.side === "ours") {
          oursOut.textContent = parsed.error || parsed.text;
          setMetrics(oursMetrics, parsed);
        }
      }
    }
  } catch (err) {
    say(err instanceof Error ? err.message : "Compare failed.");
  } finally {
    busy = false;
    compareBtn.disabled = false;
  }
}

const TURNSTILE_DUMMY = "XXXX.DUMMY.TOKEN.XXXX";

function renderCap(result: CapabilityResult) {
  const item = document.createElement("li");
  item.className = "cap";
  const head = document.createElement("header");
  const title = document.createElement("strong");
  title.textContent = result.name.replace("_", " ");
  const pill = document.createElement("span");
  pill.className = `pill pill-${result.status}`;
  pill.textContent = result.status;
  head.append(title, pill);
  const detail = document.createElement("p");
  detail.textContent = `${result.detail} (${result.latencyMs} ms)`;
  const raw = document.createElement("pre");
  raw.className = "raw";
  raw.textContent = result.raw || "";
  item.append(head, detail, raw);
  return item;
}

async function runCapabilityChecks() {
  if (busy) return;
  let creds: Creds;
  try {
    creds = requireCreds();
  } catch (err) {
    say(err instanceof Error ? err.message : "Missing credentials.");
    return;
  }
  saveCreds();
  busy = true;
  runCaps.disabled = true;
  caps.replaceChildren();
  say("");
  try {
    const res = await call("api/capabilities", {
      method: "POST",
      key: creds.key,
      body: { baseUrl: creds.baseUrl, model: creds.model, messages: [{ role: "user", content: "Reply with the word ok." }] },
    });
    const data = (await res.json().catch(() => null)) as { results?: CapabilityResult[]; error?: { message?: string } } | null;
    if (!res.ok) {
      say(messageOf(data, "Capability checks failed."));
      return;
    }
    for (const result of data?.results ?? []) caps.append(renderCap(result));
  } catch (err) {
    say(err instanceof Error ? err.message : "Capability checks failed.");
  } finally {
    busy = false;
    runCaps.disabled = false;
  }
}

function switchTab(name: string) {
  for (const tab of document.querySelectorAll<HTMLButtonElement>(".tab")) {
    const on = tab.dataset.tab === name;
    tab.classList.toggle("is-on", on);
    tab.setAttribute("aria-selected", on ? "true" : "false");
  }
  for (const panel of document.querySelectorAll<HTMLElement>(".tab-panel")) {
    panel.hidden = panel.dataset.panel !== name;
  }
}

function toggleTheme() {
  const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", next);
  try {
    localStorage.setItem("theme", next);
  } catch {
    /* ignore */
  }
}

async function boot() {
  applyCreds(loadCreds());
  temperature.addEventListener("input", () => {
    tempOut.textContent = temperature.value;
  });
  maxTokens.addEventListener("input", () => {
    tokensOut.textContent = maxTokens.value;
  });
  for (const node of [apiKey, baseUrl, model, system]) node.addEventListener("change", saveCreds);
  remember.addEventListener("change", saveCreds);
  clearKey.addEventListener("click", () => {
    apiKey.value = "";
    sessionStorage.removeItem(SESSION_STORE);
    localStorage.removeItem(LOCAL_STORE);
    localStorage.removeItem(REMEMBER_STORE);
    remember.checked = false;
    say("Key cleared from this browser.");
  });
  listModels.addEventListener("click", () => void loadModels());
  composer.addEventListener("submit", (event) => void sendChat(event));
  compareBtn.addEventListener("click", () => void runCompare());
  runCaps.addEventListener("click", () => void runCapabilityChecks());
  themeBtn.addEventListener("click", toggleTheme);
  for (const tab of document.querySelectorAll<HTMLButtonElement>(".tab")) {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab ?? "chat"));
  }

  try {
    const res = await call("api/config");
    const data = (await res.json()) as PublicConfig;
    siteKey = data.siteKey ?? "";
    testSiteKey = data.testSiteKey;
    budgetNote.textContent = data.ai === "off"
      ? "Workers AI compare is off until Turnstile is configured."
      : `${data.budget.remaining} of ${data.budget.dailyCap} compares left today${data.ai === "stub" ? " · local stub" : ""}.`;
    if (data.testSiteKey) budgetNote.textContent += " Test Turnstile key.";
    if (siteKey) mountTurnstile();
    else compareBtn.disabled = data.ai === "off";
  } catch {
    budgetNote.textContent = "Could not load config.";
  }
}

void boot();
window.addEventListener("load", () => {
  if (siteKey && !widgetId) mountTurnstile();
});
