import { LIMITS } from "../shared/limits";
import { dropOldestUntilFits, isPrintableAsciiKey, redactExact, trimUtf8, utf8ByteLength } from "../shared/text";
import type { CapabilityResult, PublicConfig, SideMetrics } from "../shared/types";
import { remountCompareAfterMint, tokenForSessionMint, type TurnstileWidget, type WidgetAction } from "./session-mint";

const SESSION_STORE = "byok.session";
const LOCAL_STORE = "byok.local";
const REMEMBER_STORE = "byok.remember";
const SESSION_READY_STORE = "byok.sessionReady";
const TURNSTILE_DUMMY = "XXXX.DUMMY.TOKEN.XXXX";

type Creds = { key: string; baseUrl: string; model: string };
type ApiError = { error?: { code?: string; message?: string } };
type HistoryTurn = { role: "user" | "assistant"; content: string; error: boolean };

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
const sessionNote = $<HTMLParagraphElement>("session-note");
const yoursMetrics = $<HTMLParagraphElement>("yours-metrics");
const oursMetrics = $<HTMLParagraphElement>("ours-metrics");
const yoursOut = $<HTMLPreElement>("yours-out");
const oursOut = $<HTMLPreElement>("ours-out");
const runCaps = $<HTMLButtonElement>("run-caps");
const caps = $<HTMLUListElement>("caps");
const status = $<HTMLParagraphElement>("status");
const turnstileHost = $<HTMLDivElement>("turnstile");
const themeBtn = $<HTMLButtonElement>("theme");
const promptNote = $<HTMLParagraphElement>("prompt-note");

let siteKey = "";
let testSiteKey = false;
let widgetId: string | null = null;
let widgetAction: WidgetAction | null = null;
let proxyOff = false;
let readyToken: string | null = null;
let tokenWaiter: ((token: string) => void) | null = null;
let busy = false;
let sessionReady = false;
let sessionInflight: Promise<void> | null = null;
let compareOff = false;
const history: HistoryTurn[] = [];

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
  if (!isPrintableAsciiKey(creds.key)) throw new Error("That API key may only contain printable ASCII.");
  if (!creds.baseUrl) throw new Error("Enter an https base URL.");
  return creds;
}

function requireCreds(): Creds {
  const creds = requireEndpoint();
  if (!creds.model) throw new Error("Enter a model id.");
  return creds;
}

async function call(path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  return fetch(api(path), { method: init.method ?? "GET", headers, body, credentials: "same-origin" });
}

function messageOf(data: unknown, fallback: string): string {
  if (!data || typeof data !== "object" || !("error" in data)) return fallback;
  const error = (data as ApiError).error;
  return error?.message || fallback;
}

function isSessionError(data: unknown): boolean {
  if (!data || typeof data !== "object" || !("error" in data)) return false;
  const code = (data as ApiError).error?.code ?? "";
  return code === "session" || code === "session_expired" || code === "session_network";
}

function persistSessionReady(value: boolean) {
  sessionReady = value;
  try {
    if (value) sessionStorage.setItem(SESSION_READY_STORE, "1");
    else sessionStorage.removeItem(SESSION_READY_STORE);
  } catch {
    /* private mode */
  }
}

function restoreSessionReady() {
  try {
    sessionReady = sessionStorage.getItem(SESSION_READY_STORE) === "1";
  } catch {
    sessionReady = false;
  }
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

function mountTurnstile(action: WidgetAction) {
  const apiRef = turnstileApi();
  if (!apiRef || !siteKey) return;
  if (widgetId) apiRef.remove(widgetId);
  readyToken = null;
  widgetAction = action;
  widgetId = apiRef.render(turnstileHost, {
    sitekey: siteKey,
    action,
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

const turnstileWidget: TurnstileWidget = {
  get action() {
    return widgetId ? widgetAction : null;
  },
  mount: mountTurnstile,
  takeToken,
};

async function mintSession(): Promise<void> {
  const body: Record<string, string> = {};
  const token = await tokenForSessionMint(turnstileWidget, { siteKey, testSiteKey, dummy: TURNSTILE_DUMMY });
  if (token) body.turnstileToken = token;
  const res = await call("api/session", { method: "POST", body });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as unknown;
    throw new Error(messageOf(data, "Complete the Turnstile check so this browser can call your endpoint."));
  }
  persistSessionReady(true);
  sessionNote.textContent = siteKey
    ? "Signed session cookie is set. Compare still needs action compare."
    : "Signed session cookie is set. Compare is off until Turnstile is configured.";
  remountCompareAfterMint(turnstileWidget, { siteKey, testSiteKey });
}

async function ensureSession(force = false): Promise<void> {
  if (sessionReady && !force) return;
  if (sessionInflight) return sessionInflight;
  sessionInflight = mintSession().finally(() => {
    sessionInflight = null;
  });
  return sessionInflight;
}

async function callAuthed(path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  await ensureSession();
  let res = await call(path, init);
  if (res.status === 401) {
    const data = (await res.clone().json().catch(() => null)) as unknown;
    if (isSessionError(data)) {
      persistSessionReady(false);
      await ensureSession(true);
      res = await call(path, init);
    }
  }
  return res;
}

function addBubble(role: "user" | "assistant", text: string, error = false): { body: HTMLElement; index: number } {
  const index = history.length;
  history.push({ role, content: text, error });
  const item = document.createElement("li");
  item.className = `bubble ${role}${error ? " error" : ""}`;
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = role === "user" ? "You" : "Model";
  const body = document.createElement("div");
  body.textContent = text;
  item.append(who, body);
  transcript.append(item);
  item.scrollIntoView({ block: "end" });
  return { body, index };
}

function setBubble(index: number, text: string, error = false) {
  const turn = history[index];
  if (!turn) return;
  turn.content = text;
  turn.error = error;
  const node = transcript.children[index]?.querySelector("div");
  if (node) node.textContent = text;
  transcript.children[index]?.classList.toggle("error", error);
  if (error && turn.role === "assistant" && index > 0) {
    const prev = history[index - 1];
    if (prev?.role === "user") {
      prev.error = true;
      transcript.children[index - 1]?.classList.toggle("error", true);
    }
  }
}

function transcriptMessages(): { role: "user" | "assistant"; content: string }[] {
  return history
    .filter((turn) => !turn.error && turn.content.trim())
    .slice(-LIMITS.maxMessages)
    .map((turn) => ({
      role: turn.role,
      content: turn.role === "assistant" ? trimUtf8(turn.content, LIMITS.maxMessageBytes) : turn.content,
    }));
}

function chatBody(creds: Creds, extra: Record<string, unknown> = {}) {
  const extraMessages = extra.messages as { role: "user" | "assistant"; content: string }[] | undefined;
  const rest = { ...extra };
  delete rest.messages;
  return dropOldestUntilFits(
    {
      apiKey: creds.key,
      baseUrl: creds.baseUrl,
      model: creds.model,
      system: system.value,
      temperature: Number(temperature.value),
      max_tokens: Number(maxTokens.value),
      ...rest,
      messages: extraMessages ?? transcriptMessages(),
    },
    LIMITS.requestBytes,
  );
}

function promptOverLimit(): string | null {
  const bytes = utf8ByteLength(prompt.value);
  if (bytes > LIMITS.maxMessageBytes) {
    return `That message is ${bytes} bytes. The limit is ${LIMITS.maxMessageBytes} bytes (~1,300 CJK or Devanagari characters).`;
  }
  if (utf8ByteLength(system.value) > LIMITS.maxSystemBytes) {
    return `The system prompt is ${utf8ByteLength(system.value)} bytes. The limit is ${LIMITS.maxSystemBytes} bytes.`;
  }
  return null;
}

function updatePromptNote() {
  const bytes = utf8ByteLength(prompt.value);
  promptNote.textContent = `${bytes} / ${LIMITS.maxMessageBytes} bytes`;
  promptNote.classList.toggle("is-over", bytes > LIMITS.maxMessageBytes);
}

function handleSseLine(
  line: string,
  state: { eventName: string; text: string; sawDone: boolean; secrets: readonly string[] },
  target: HTMLElement,
): boolean {
  if (line.startsWith("event:")) {
    state.eventName = line.slice(6).trim();
    return false;
  }
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return false;
  const payload = trimmed.slice(5).trim();
  if (!payload) return false;
  if (payload === "[DONE]") {
    state.sawDone = true;
    return false;
  }
  if (state.eventName === "error") {
    try {
      const parsed = JSON.parse(payload) as { message?: string };
      const message = parsed.message || "The stream failed.";
      target.textContent = state.text ? `${state.text}\n${message}` : message;
    } catch {
      target.textContent = state.text ? `${state.text}\n${payload}` : payload;
    }
    return true;
  }
  try {
    const parsed = JSON.parse(payload) as { choices?: { delta?: { content?: string }; message?: { content?: string } }[] };
    const piece = parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content ?? "";
    if (piece) {
      state.text += piece;
      target.textContent = redactExact(state.text, state.secrets);
    }
  } catch {
    /* ignore */
  }
  return false;
}

async function readSseChat(res: Response, target: HTMLElement, secrets: readonly string[]) {
  const reader = res.body?.getReader();
  if (!reader) {
    target.textContent = "stream ended early";
    return { text: "", error: true, sawDone: false };
  }
  const decoder = new TextDecoder();
  let carry = "";
  const state = { eventName: "message", text: "", sawDone: false, secrets };
  let failed = false;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      carry += decoder.decode();
      if (carry) failed = handleSseLine(carry, state, target) || failed;
      break;
    }
    carry += decoder.decode(chunk.value, { stream: true });
    const lines = carry.split(/\r?\n/);
    carry = lines.pop() ?? "";
    for (const line of lines) {
      if (handleSseLine(line, state, target)) failed = true;
    }
  }
  const display = redactExact(state.text, secrets);
  if (failed) return { text: target.textContent ?? display, error: true, sawDone: state.sawDone };
  if (!state.sawDone) {
    const suffix = "stream ended early";
    target.textContent = display ? `${display}\n${suffix}` : suffix;
    return { text: display, error: !display, sawDone: false };
  }
  if (!target.textContent) target.textContent = "(empty reply)";
  return { text: display, error: false, sawDone: true };
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
  const over = promptOverLimit();
  if (over) {
    say(over);
    updatePromptNote();
    return;
  }
  saveCreds();
  addBubble("user", text);
  prompt.value = "";
  const reply = addBubble("assistant", "");
  busy = true;
  send.disabled = true;
  say("");
  try {
    const res = await callAuthed("api/proxy/chat/stream", { method: "POST", body: chatBody(creds) });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as unknown;
      const message = messageOf(data, "The endpoint returned an error.");
      setBubble(reply.index, message, true);
      say(message);
      return;
    }
    const result = await readSseChat(res, reply.body, [creds.key]);
    setBubble(reply.index, result.text || reply.body.textContent || "", result.error);
  } catch (err) {
    const message = err instanceof Error ? err.message : "The chat request failed.";
    setBubble(reply.index, message, true);
    say(message);
  } finally {
    busy = false;
    send.disabled = proxyOff;
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
    const res = await callAuthed("api/proxy/models", { method: "POST", body: { apiKey: creds.key, baseUrl: creds.baseUrl } });
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

function consumeCompareLine(line: string, eventName: { value: string }): void {
  if (line.startsWith("event:")) {
    eventName.value = line.slice(6).trim();
    return;
  }
  if (!line.startsWith("data:")) return;
  const payload = line.slice(5).trim();
  if (!payload) return;
  if (eventName.value === "error") {
    say("Compare failed.");
    return;
  }
  const parsed = JSON.parse(payload) as SideMetrics;
  if (eventName.value === "yours" || parsed.side === "yours") {
    yoursOut.textContent = parsed.error || parsed.text;
    setMetrics(yoursMetrics, parsed);
  }
  if (eventName.value === "ours" || parsed.side === "ours") {
    oursOut.textContent = parsed.error || parsed.text;
    setMetrics(oursMetrics, parsed);
  }
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
  const over = prompt.value.trim() ? promptOverLimit() : utf8ByteLength(system.value) > LIMITS.maxSystemBytes ? promptOverLimit() : null;
  if (over) {
    say(over);
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
    await ensureSession();
    const token = testSiteKey || !siteKey ? TURNSTILE_DUMMY : await takeToken();
    const res = await callAuthed("api/compare", {
      method: "POST",
      body: {
        ...chatBody(creds, { messages: [{ role: "user", content: text }] }),
        turnstileToken: token,
        max_tokens: Math.min(Number(maxTokens.value), LIMITS.compareMaxTokens),
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
    const eventName = { value: "message" };
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        carry += decoder.decode();
        if (carry) consumeCompareLine(carry, eventName);
        break;
      }
      carry += decoder.decode(chunk.value, { stream: true });
      const lines = carry.split(/\r?\n/);
      carry = lines.pop() ?? "";
      for (const line of lines) consumeCompareLine(line, eventName);
    }
    await refreshConfig();
  } catch (err) {
    say(err instanceof Error ? err.message : "Compare failed.");
  } finally {
    busy = false;
    compareBtn.disabled = compareOff || proxyOff;
  }
}

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
    const res = await callAuthed("api/capabilities", {
      method: "POST",
      body: { apiKey: creds.key, baseUrl: creds.baseUrl, model: creds.model, messages: [{ role: "user", content: "Reply with the word ok." }] },
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
    runCaps.disabled = proxyOff;
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

async function refreshConfig() {
  try {
    const res = await call("api/config");
    const data = (await res.json()) as PublicConfig;
    siteKey = data.siteKey ?? "";
    testSiteKey = data.testSiteKey;
    proxyOff = data.session === "off";
    compareOff = data.ai === "off" || proxyOff;
    compareBtn.disabled = compareOff;
    listModels.disabled = proxyOff;
    if (!busy) {
      send.disabled = proxyOff;
      runCaps.disabled = proxyOff;
    }
    if (proxyOff) {
      budgetNote.textContent = "Proxy is off until Turnstile is configured.";
      sessionNote.textContent = "Proxy is off until Turnstile is configured.";
    } else {
      budgetNote.textContent =
        data.ai === "off"
          ? "Workers AI compare is off. Chat and models still work."
          : `${data.budget.remaining} of ${data.budget.dailyCap} compares left today${data.ai === "stub" ? " · local stub" : ""}.`;
      if (data.testSiteKey) budgetNote.textContent += " Test Turnstile key.";
      if (data.session === "local" || testSiteKey) {
        try {
          await ensureSession();
        } catch (err) {
          sessionNote.textContent = err instanceof Error ? err.message : "Could not mint a session.";
        }
      } else if (siteKey && !widgetId) {
        mountTurnstile(sessionReady ? "compare" : "session");
      }
    }
  } catch {
    budgetNote.textContent = "Could not load config.";
  }
}

async function boot() {
  restoreSessionReady();
  applyCreds(loadCreds());
  temperature.addEventListener("input", () => {
    tempOut.textContent = temperature.value;
  });
  maxTokens.addEventListener("input", () => {
    tokensOut.textContent = maxTokens.value;
  });
  for (const node of [apiKey, baseUrl, model, system]) node.addEventListener("change", saveCreds);
  prompt.addEventListener("input", updatePromptNote);
  updatePromptNote();
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

  await refreshConfig();
}

void boot();
window.addEventListener("load", () => {
  if (!proxyOff && siteKey && !widgetId && !testSiteKey) mountTurnstile(sessionReady ? "compare" : "session");
});
