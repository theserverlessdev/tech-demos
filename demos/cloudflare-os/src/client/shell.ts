import { RpcTarget, newWebSocketRpcSession } from "capnweb";
import type {
  ActionRecord,
  BindingName,
  BlueprintInfo,
  ChatMessage,
  GadgetFiles,
  GadgetInfo,
  RpcEvent,
  StorageReport,
  Viewer,
  WorkspaceEvent,
  WorkspaceSnapshot,
} from "../shared/types";
import { clock, h, icon, logoMark, renderMarkdown, timeAgo } from "./dom";
import { FrameBridge, sandboxHtml } from "./gadget-frame";

// Cap'n Web stubs are dynamic. Typing them as `any` avoids deep type instantiation in the checker.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Stub = any;

// ===================================================================== identity and routing

const BASE = location.pathname.startsWith("/demos/cloudflare-os") ? "/demos/cloudflare-os" : "";
const HUB_URL = "https://tech-demos.theserverless.dev/";
const UPSTREAM_URL = "https://github.com/cloudflare/cloudflare-os";

function randomId(len: number): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

function workspaceId(): string {
  const url = new URL(location.href);
  const current = url.searchParams.get("w");
  if (current && /^[a-z0-9]{8,24}$/.test(current)) return current;
  const id = randomId(12);
  url.searchParams.set("w", id);
  history.replaceState(null, "", url);
  return id;
}

const ADJECTIVES = ["Ember", "Graphite", "Quiet", "Swift", "Amber", "Copper", "Lunar", "Brisk", "Cobalt", "Velvet", "Nimble"];
const ANIMALS = ["Fox", "Heron", "Otter", "Lynx", "Wren", "Marten", "Ibex", "Kestrel", "Hare", "Newt", "Raven", "Stoat"];
const COLORS = ["#c2410c", "#e2622e", "#b7791f", "#4d9e6a", "#2f7d8c", "#3b5bdb", "#7c4dff", "#b4637a"];

function viewerIdentity(): Viewer {
  try {
    const stored = sessionStorage.getItem("cos-viewer");
    if (stored) return JSON.parse(stored) as Viewer;
  } catch {}
  const pick = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)]!;
  const viewer = { id: randomId(10), name: `${pick(ADJECTIVES)} ${pick(ANIMALS)}`, color: pick(COLORS) };
  try {
    sessionStorage.setItem("cos-viewer", JSON.stringify(viewer));
  } catch {}
  return viewer;
}

const WS_ID = workspaceId();
const viewer = viewerIdentity();

// ===================================================================== state

type View = "app" | "code" | "connections" | "storage";
type Drawer = "activity" | "system" | null;

const state = {
  snap: null as WorkspaceSnapshot | null,
  conn: "connecting" as "connecting" | "live" | "offline",
  blueprints: [] as BlueprintInfo[],
  active: null as string | null,
  view: "app" as View,
  drawer: null as Drawer,
  mobile: "agent" as "agent" | "gadgets",
  trace: [] as (RpcEvent & { rtt?: number })[],
  logs: [] as { gadget: string; level: string; message: string; at: number }[],
  code: new Map<string, { version: number; files: GadgetFiles; drafts: Partial<GadgetFiles>; file: keyof GadgetFiles }>(),
  storage: new Map<string, { report: StorageReport | null; error?: string; loading: boolean; at: number }>(),
  chatSig: "",
  lastChatId: 0,
  sending: false,
};

let session: Stub = null;
let rootStub: Stub = null;

// ===================================================================== helpers

function theme(): "dark" | "light" {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

function gadgets(): GadgetInfo[] {
  return state.snap?.gadgets ?? [];
}

function gadgetById(id: string | null): GadgetInfo | undefined {
  return gadgets().find((g) => g.id === id);
}

function pendingActions(): ActionRecord[] {
  return (state.snap?.actions ?? []).filter((a) => a.status === "pending");
}

function errMsg(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error:\s*/, "");
}

const toasts = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
function toast(text: string, kind: "info" | "error" = "info") {
  const el = h("div", { class: `toast${kind === "error" ? " toast--error" : ""}` }, text);
  toasts.append(el);
  setTimeout(() => el.remove(), kind === "error" ? 6000 : 3200);
}

async function guarded<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    toast(`${label}: ${errMsg(err)}`, "error");
    return undefined;
  }
}

const SUGGESTIONS = [
  "Make a 5-slide deck about Durable Object facets",
  "Let's play tic-tac-toe. You play O.",
  "Draw a lightning bolt on a pixel board",
  "Show me the Hacker News front page",
  "Write a gadget: a shared checklist for a launch",
];

// ===================================================================== skeleton

const app = document.getElementById("app")!;

const titleInput = h("input", { class: "ws-title", "aria-label": "Workspace title", maxlength: 80, spellcheck: "false" }) as HTMLInputElement;
const connEl = h("span", { class: "conn", "data-state": "connecting" }, h("span", { class: "conn__dot" }), h("span", { class: "conn__label" }, "Connecting"));
const presenceEl = h("div", { class: "presence" });
const costEl = h("span", { class: "chip cost", "data-tip": "Workers AI spend in this workspace" }, "AI $0.0000");
const activityBtn = h("button", { class: "icon-btn", "data-tip": "Activity and approvals", "aria-label": "Activity" }, icon("shield"));
const systemBtn = h("button", { class: "icon-btn", "data-tip": "System: live RPC trace", "aria-label": "System" }, icon("pulse"));
const themeBtn = h("button", { class: "icon-btn", "data-tip": "Theme", "aria-label": "Toggle theme" }, icon(theme() === "dark" ? "sun" : "moon"));

const topbar = h(
  "header",
  { class: "topbar" },
  h("a", { class: "brand", href: HUB_URL, "aria-label": "Tech demos on theserverless.dev" }, logoMark(28), h("span", { class: "brand__word" }, "theserverless", h("span", { class: "brand__tld" }, ".dev"))),
  h(
    "div",
    { class: "crumbs" },
    h("span", { class: "crumbs__sep" }, "/"),
    h("span", { class: "crumbs__app" }, h("a", { href: HUB_URL }, "demos"), h("span", { class: "crumbs__sep" }, "/"), "Cloudflare OS", h("span", { class: "chip chip--ember" }, "slice")),
    h("span", { class: "crumbs__sep" }, "/"),
    titleInput,
  ),
  h(
    "div",
    { class: "top-actions" },
    connEl,
    presenceEl,
    costEl,
    h("span", { class: "top-divider" }),
    activityBtn,
    systemBtn,
    h("button", { class: "btn btn-sm", onclick: share, "data-tip": "Copy the workspace link" }, icon("link", "icon icon-sm"), "Share"),
    themeBtn,
  ),
);

const rail = h(
  "nav",
  { class: "rail", "aria-label": "Workspace" },
  h("button", { class: "icon-btn", "data-tip": "Agent chat", "aria-pressed": "true", id: "rail-chat", onclick: toggleChat }, icon("chat")),
  h("button", { class: "icon-btn", "data-tip": "Blueprints", onclick: () => openBlueprints() }, icon("grid")),
  h("button", { class: "icon-btn", "data-tip": "Activity", id: "rail-activity", onclick: () => toggleDrawer("activity") }, icon("shield")),
  h("button", { class: "icon-btn", "data-tip": "System", id: "rail-system", onclick: () => toggleDrawer("system") }, icon("pulse")),
  h("span", { class: "rail__sep" }),
  h("button", { class: "icon-btn", "data-tip": "New workspace", onclick: newWorkspace }, icon("plus")),
  h("span", { class: "rail__spacer" }),
  h("button", { class: "icon-btn", "data-tip": "About this slice", onclick: openAbout }, icon("info")),
  h("a", { class: "icon-btn", "data-tip": "Upstream: cloudflare/cloudflare-os", href: UPSTREAM_URL, target: "_blank", rel: "noopener" }, icon("github")),
);

// ---- chat pane
const messagesEl = h("div", { class: "messages", "aria-live": "polite" });
const agentStatusText = h("span", { class: "chip" }, "idle");
const composerInput = h("textarea", { rows: 1, placeholder: "Ask for a gadget, or tell one what to do…", "aria-label": "Message the agent" }) as HTMLTextAreaElement;
const sendBtn = h("button", { class: "composer__send", "aria-label": "Send" }, icon("send")) as HTMLButtonElement;
const suggestionsEl = h(
  "div",
  { class: "suggestions" },
  SUGGESTIONS.map((s) => h("button", { class: "suggestion", onclick: () => sendChat(s) }, s)),
);
const chat = h(
  "section",
  { class: "chat", "aria-label": "Agent" },
  h(
    "div",
    {},
    h("div", { class: "pane-head" }, h("h2", {}, "Agent"), h("span", { class: "chip", id: "model-chip" }, "Workers AI"), h("span", { class: "pane-head__spacer" }), agentStatusText),
    h("div", { class: "agent-status" }),
  ),
  messagesEl,
  h(
    "div",
    { class: "composer" },
    suggestionsEl,
    h("div", { class: "composer__box" }, composerInput, sendBtn),
    h("div", { class: "composer__foot" }, h("span", {}, "Enter to send"), h("span", { id: "presence-note" }, "")),
  ),
);

// ---- gadget pane
const tabsEl = h("div", { class: "tabs", role: "tablist", "aria-label": "Gadgets" });
const subbarEl = h("div", { class: "subbar" });
const frameHost = h("div", { class: "frame-host" });
const appView = h("div", { class: "view", "data-view": "app" }, frameHost);
const codeView = h("div", { class: "view", "data-view": "code", hidden: true });
const connView = h("div", { class: "view", "data-view": "connections", hidden: true });
const storageView = h("div", { class: "view", "data-view": "storage", hidden: true });
const emptyView = h("div", { class: "view", "data-view": "empty", hidden: true });
const bannerHost = h("div");
const paneBody = h("div", { class: "pane-body" }, appView, codeView, connView, storageView, emptyView, bannerHost);

const activityDrawer = h("aside", { class: "drawer", "aria-label": "Activity" });
const systemDrawer = h("aside", { class: "drawer", "aria-label": "System" });

const gadgetPane = h("section", { class: "gadgets", "aria-label": "Gadgets" }, tabsEl, subbarEl, paneBody, activityDrawer, systemDrawer);

const splitter = h("div", { class: "splitter", role: "separator", "aria-orientation": "vertical", "aria-label": "Resize chat" });
const main = h("div", { class: "main" }, rail, chat, splitter, gadgetPane);

const mobileNav = h("nav", { class: "mobile-nav" });

// ===================================================================== connection

class WorkspaceListener extends RpcTarget {
  event(e: WorkspaceEvent) {
    onEvent(e);
  }
}

let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectDelay = 800;
let heartbeat: ReturnType<typeof setInterval> | undefined;

function wsUrl() {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${BASE}/api`;
}

function setConn(next: typeof state.conn) {
  state.conn = next;
  connEl.setAttribute("data-state", next);
  connEl.querySelector(".conn__label")!.textContent = next === "live" ? "Live" : next === "connecting" ? "Connecting" : "Offline";
}

async function connect() {
  clearTimeout(reconnectTimer);
  setConn("connecting");
  const root: Stub = newWebSocketRpcSession(wsUrl());
  rootStub = root;
  root.onRpcBroken(() => {
    if (rootStub !== root) return;
    session = null;
    setConn("offline");
    scheduleReconnect();
  });
  try {
    const ws: Stub = root.openWorkspace(WS_ID, viewer);
    state.blueprints = await ws.listBlueprints();
    session = ws;
    await ws.subscribe(new WorkspaceListener());
    reconnectDelay = 800;
    setConn("live");
    // Frame sessions belonged to the old socket. Mount them again.
    for (const id of [...frames.keys()]) {
      const g = gadgetById(id);
      if (g) void mountFrame(g, "Reconnecting");
    }
    clearInterval(heartbeat);
    heartbeat = setInterval(() => {
      if (session === ws) ws.ping().catch(() => {});
    }, 20_000);
    render();
  } catch (err) {
    console.error("connect failed", err);
    if (rootStub === root) {
      setConn("offline");
      scheduleReconnect();
    }
  }
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => void connect(), reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.8, 10_000);
}

// ===================================================================== events

function onEvent(e: WorkspaceEvent) {
  switch (e.type) {
    case "snapshot": {
      const first = !state.snap;
      state.snap = e.snapshot;
      if (!state.active || !gadgetById(state.active)) state.active = e.snapshot.gadgets.at(-1)?.id ?? null;
      if (first && state.active) state.mobile = "gadgets";
      render();
      break;
    }
    case "focus":
      state.active = e.gadget;
      state.view = "app";
      state.mobile = "gadgets";
      render();
      flashTab(e.gadget);
      break;
    case "gadget-reloaded": {
      state.code.delete(e.gadget);
      const g = gadgetById(e.gadget);
      if (frames.has(e.gadget)) {
        const version = frames.get(e.gadget)!.version;
        if (version !== e.version) void mountFrame({ ...(g ?? ({ id: e.gadget, title: e.gadget } as GadgetInfo)), version: e.version }, `Loading v${e.version} in a new Dynamic Worker`);
      }
      break;
    }
    case "gadget-removed":
      unmountFrame(e.gadget);
      state.code.delete(e.gadget);
      state.storage.delete(e.gadget);
      break;
    case "rpc":
      onRpc(e.event);
      break;
    case "log":
      pushLog(e.gadget, e.level, e.message);
      break;
  }
}

const localRtt = new Map<string, number>();

function onRpc(event: RpcEvent) {
  const key = `${event.gadget}.${event.method}`;
  const row = { ...event, rtt: event.who === viewer.name && event.via === "ui" ? localRtt.get(key) : undefined };
  state.trace.unshift(row);
  if (state.trace.length > 120) state.trace.length = 120;
  pulseFlow(event.via);
  if (state.drawer === "system") renderSystem();
  if (state.view === "storage" && event.gadget === state.active && event.via !== "platform") scheduleStorageRefresh();
}

function pushLog(gadget: string, level: string, message: string) {
  state.logs.unshift({ gadget, level, message, at: Date.now() });
  if (state.logs.length > 60) state.logs.length = 60;
  if (state.drawer === "system") renderSystem();
}

// ===================================================================== frames

type FrameEntry = { iframe: HTMLIFrameElement; bridge: FrameBridge; version: number; overlay: HTMLElement | null };
const frames = new Map<string, FrameEntry>();

function traceLocal(gadgetId: string, method: string, ms: number) {
  localRtt.set(`${gadgetId}.${method}`, Math.round(ms));
}

async function mountFrame(g: Pick<GadgetInfo, "id" | "title" | "version">, message = "Starting gadget") {
  if (!session) return;
  const previous = frames.get(g.id);
  const iframe = h("iframe", {
    sandbox: "allow-scripts allow-popups allow-popups-to-escape-sandbox",
    title: `${g.title} (sandboxed gadget UI)`,
    referrerpolicy: "no-referrer",
  }) as HTMLIFrameElement;
  iframe.hidden = g.id !== state.active;
  const overlay = h("div", { class: "frame-overlay" }, h("div", { class: "spinner" }), message);
  overlay.hidden = g.id !== state.active;
  const ws = session;
  const bridge = new FrameBridge(g.id, () => ws.connectToGadget(g.id), traceLocal);
  const entry: FrameEntry = { iframe, bridge, version: g.version, overlay };
  frames.set(g.id, entry);
  frameHost.append(iframe, overlay);
  if (previous) {
    previous.bridge.dispose();
    // Keep the old frame visible for a moment so the reload does not flash.
    setTimeout(() => {
      previous.iframe.remove();
      previous.overlay?.remove();
    }, 60);
  }
  try {
    const bundle = await ws.getUiBundle(g.id);
    if (frames.get(g.id) !== entry) return;
    entry.version = bundle.version;
    iframe.srcdoc = sandboxHtml(bundle.jsCode, { id: g.id, title: g.title, viewer: { name: viewer.name, color: viewer.color } }, theme());
    setTimeout(() => clearOverlay(g.id, entry), 9000);
  } catch (err) {
    overlay.textContent = `Could not load the UI: ${errMsg(err)}`;
  }
}

function clearOverlay(id: string, entry = frames.get(id)) {
  if (!entry?.overlay) return;
  const el = entry.overlay;
  entry.overlay = null;
  el.style.transition = "opacity .25s";
  el.style.opacity = "0";
  setTimeout(() => el.remove(), 260);
}

function unmountFrame(id: string) {
  const entry = frames.get(id);
  if (!entry) return;
  entry.bridge.dispose();
  entry.iframe.remove();
  entry.overlay?.remove();
  frames.delete(id);
}

window.addEventListener("message", (e: MessageEvent) => {
  // Sandboxed frames have the opaque origin, which the browser reports as the string "null".
  if (e.origin !== "null") return;
  for (const [id, entry] of frames) {
    if (entry.iframe.contentWindow !== e.source) continue;
    if (e.data === "handshake" && e.ports[0]) {
      const port = e.ports[0];
      entry.bridge
        .handshake(port)
        .then(() => setTimeout(() => clearOverlay(id, entry), 120))
        .catch((err) => {
          port.close();
          pushLog(id, "error", `Handshake failed: ${errMsg(err)}`);
        });
    } else if (e.data && typeof e.data === "object" && e.data.type === "console") {
      pushLog(id, String(e.data.level), String(e.data.message).slice(0, 600));
    }
    return;
  }
});

function syncFrames() {
  const ids = new Set(gadgets().map((g) => g.id));
  for (const id of [...frames.keys()]) if (!ids.has(id)) unmountFrame(id);
  const active = gadgetById(state.active);
  if (active && state.view === "app" && !frames.has(active.id) && session) void mountFrame(active);
  for (const [id, entry] of frames) {
    const visible = id === state.active && state.view === "app";
    entry.iframe.hidden = !visible;
    if (entry.overlay) entry.overlay.hidden = !visible;
  }
}

// ===================================================================== render

function render() {
  const snap = state.snap;
  app.setAttribute("aria-busy", snap ? "false" : "true");
  app.setAttribute("data-mobile", state.mobile);
  if (!snap) return;

  if (document.activeElement !== titleInput) titleInput.value = snap.title;
  document.title = `${snap.title} · Cloudflare OS, sliced`;
  renderPresence(snap);
  costEl.textContent = `AI $${snap.cost.usd.toFixed(4)}`;
  const pending = pendingActions().length;
  setBadge(activityBtn, pending);
  setBadge(document.getElementById("rail-activity"), pending);
  activityBtn.setAttribute("aria-pressed", String(state.drawer === "activity"));
  systemBtn.setAttribute("aria-pressed", String(state.drawer === "system"));
  document.getElementById("rail-activity")?.setAttribute("aria-pressed", String(state.drawer === "activity"));
  document.getElementById("rail-system")?.setAttribute("aria-pressed", String(state.drawer === "system"));
  document.getElementById("model-chip")!.textContent = snap.agent.model.replace(/^@cf\/[^/]+\//, "");

  renderChat(snap);
  renderTabs();
  renderSubbar();
  renderViews();
  renderBanner();
  renderMobileNav();
  if (state.drawer === "activity") renderActivity();
  if (state.drawer === "system") renderSystem();
  activityDrawer.classList.toggle("open", state.drawer === "activity");
  systemDrawer.classList.toggle("open", state.drawer === "system");
  syncFrames();
}

function setBadge(el: Element | null, count: number) {
  if (!el) return;
  el.querySelector(".badge")?.remove();
  if (count > 0) el.append(h("span", { class: "badge" }, String(count)));
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function renderPresence(snap: WorkspaceSnapshot) {
  presenceEl.textContent = "";
  const people = [...snap.presence].sort((a, b) => (a.id === viewer.id ? -1 : b.id === viewer.id ? 1 : 0));
  for (const p of people.slice(0, 5)) {
    presenceEl.append(
      h("span", { class: `avatar${p.id === viewer.id ? " avatar--me" : ""}`, style: `background:${p.color}`, "data-tip": p.id === viewer.id ? `${p.name} (you)` : p.name }, initials(p.name)),
    );
  }
  if (people.length > 5) presenceEl.append(h("span", { class: "avatar", style: "background:var(--surface-3);color:var(--text)" }, `+${people.length - 5}`));
  const note = document.getElementById("presence-note");
  if (note) note.textContent = `${snap.presence.length} shell${snap.presence.length === 1 ? "" : "s"} connected`;
}

// ---- chat

function renderChat(snap: WorkspaceSnapshot) {
  chat.setAttribute("data-busy", String(snap.agent.busy));
  agentStatusText.textContent = snap.agent.busy ? (snap.agent.status ?? "Working") : "idle";
  agentStatusText.className = snap.agent.busy ? "chip chip--ember" : "chip";
  sendBtn.disabled = snap.agent.busy || state.sending;
  suggestionsEl.hidden = snap.chat.filter((m) => m.role === "user").length > 2;

  const last = snap.chat.at(-1);
  const sig = `${snap.chat.length}:${last?.id ?? 0}:${snap.agent.busy}`;
  if (sig === state.chatSig) return;
  state.chatSig = sig;

  const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
  messagesEl.textContent = "";
  for (const m of snap.chat) {
    const el = renderMessage(m);
    if (m.id > state.lastChatId && state.lastChatId > 0) el.classList.add("is-new");
    messagesEl.append(el);
  }
  state.lastChatId = Math.max(state.lastChatId, last?.id ?? 0);
  if (nearBottom || last?.author === viewer.name || last?.role !== "user") messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderMessage(m: ChatMessage): HTMLElement {
  if (m.role === "tool" && m.tool) {
    const t = m.tool;
    return h(
      "div",
      { class: "tool", "data-ok": String(t.ok) },
      h("span", { class: "tool__icon" }, icon(t.ok ? "bolt" : "x", "icon icon-sm")),
      h("span", { class: "tool__name" }, t.name),
      t.gadget && gadgetById(t.gadget)
        ? h("button", { class: "tool__open", onclick: () => focusGadget(t.gadget!) }, `open ${t.gadget}`)
        : h("span", { class: "chip" }, t.ok ? "ok" : "failed"),
      h("span", { class: "tool__args", title: t.args }, t.args),
      h("span", { class: "tool__result", title: t.result }, `→ ${t.result}`),
    );
  }
  if (m.role === "system") {
    return h("div", { class: "msg msg--system" }, h("div", { class: "msg__body" }, m.content));
  }
  if (m.role === "user") {
    return h(
      "div",
      { class: "msg msg--user" },
      h("div", { class: "msg__meta" }, h("span", { class: "msg__dot", style: `background:${m.color ?? "var(--ember)"}` }), m.author ?? "Visitor", h("span", {}, "·"), timeAgo(m.at)),
      h("div", { class: "msg__body" }, m.content),
    );
  }
  return h(
    "div",
    { class: "msg msg--assistant" },
    h("div", { class: "msg__meta" }, logoMark(14), "Agent", h("span", {}, "·"), timeAgo(m.at)),
    h("div", { class: "msg__body" }, renderMarkdown(m.content)),
  );
}

async function sendChat(text?: string) {
  const content = (text ?? composerInput.value).trim();
  if (!content || !session || state.snap?.agent.busy) return;
  composerInput.value = "";
  autosize();
  state.sending = true;
  sendBtn.disabled = true;
  try {
    await session.chat(content);
  } catch (err) {
    toast(errMsg(err), "error");
  } finally {
    state.sending = false;
    render();
  }
}

function autosize() {
  composerInput.style.height = "auto";
  composerInput.style.height = `${Math.min(composerInput.scrollHeight, 160)}px`;
}

// ---- tabs and subbar

function renderTabs() {
  tabsEl.textContent = "";
  for (const g of gadgets()) {
    const selected = g.id === state.active;
    tabsEl.append(
      h(
        "div",
        {
          class: "tab",
          role: "tab",
          tabindex: 0,
          "aria-selected": String(selected),
          "data-id": g.id,
          onclick: () => focusGadget(g.id),
          onkeydown: (e: Event) => {
            if ((e as KeyboardEvent).key === "Enter") focusGadget(g.id);
          },
        },
        h("span", { class: "tab__icon" }, icon(g.icon, "icon icon-sm")),
        g.title,
        h("span", { class: "tab__ver" }, `v${g.version}`),
        h(
          "button",
          {
            class: "tab__close",
            "aria-label": `Remove ${g.title}`,
            title: "Remove gadget and its facet storage",
            onclick: (e: Event) => {
              e.stopPropagation();
              void removeGadget(g);
            },
          },
          icon("x", "icon icon-sm"),
        ),
      ),
    );
  }
  requestAnimationFrame(() => tabsEl.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" }));
  tabsEl.append(h("button", { class: "icon-btn tab-add", "aria-label": "New gadget", "data-tip": "New gadget", onclick: () => openBlueprints() }, icon("plus")));
}

function flashTab(id: string) {
  const el = tabsEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
  el?.classList.remove("flash");
  void (el as HTMLElement | null)?.offsetWidth;
  el?.classList.add("flash");
}

function focusGadget(id: string) {
  state.active = id;
  if (state.view === "app" || !gadgetById(id)) state.view = "app";
  state.mobile = "gadgets";
  render();
}

async function removeGadget(g: GadgetInfo) {
  if (!session) return;
  const tab = tabsEl.querySelector(`[data-id="${CSS.escape(g.id)}"] .tab__close`);
  if (tab && tab.getAttribute("data-armed") !== "1") {
    tab.setAttribute("data-armed", "1");
    toast(`Click × again to remove ${g.title} and delete its facet SQLite.`);
    setTimeout(() => tab.removeAttribute("data-armed"), 3000);
    return;
  }
  await guarded("Remove failed", () => session.removeGadget(g.id));
}

function renderSubbar() {
  subbarEl.textContent = "";
  const g = gadgetById(state.active);
  if (!g) {
    subbarEl.hidden = true;
    return;
  }
  subbarEl.hidden = false;
  const views: [View, string, string][] = [
    ["app", "App", "window"],
    ["code", "Code", "code"],
    ["connections", "Connections", "plug"],
    ["storage", "Storage", "database"],
  ];
  subbarEl.append(
    h(
      "div",
      { class: "seg", role: "tablist", "aria-label": "Gadget views" },
      views.map(([v, label, ic]) =>
        h(
          "button",
          {
            role: "tab",
            "aria-selected": String(state.view === v),
            onclick: () => {
              state.view = v;
              render();
            },
          },
          icon(ic, "icon icon-sm"),
          label,
        ),
      ),
    ),
    h(
      "div",
      { class: "subbar__meta" },
      h("span", { class: "chip", title: `Worker Loader ID: ${g.loaderId}` }, icon("cpu", "icon icon-sm"), g.loaderId.length > 26 ? `${g.loaderId.slice(0, 26)}…` : g.loaderId),
      h("span", { class: "chip", title: "Durable Object facet with its own SQLite database" }, icon("database", "icon icon-sm"), `facet ${g.id}`),
      h(
        "span",
        { class: g.bindings.length ? "chip chip--ember" : "chip", title: "globalOutbound is null. Bindings are the only way out." },
        icon("globe", "icon icon-sm"),
        g.bindings.length ? `egress via ${g.bindings.join(" + ")}` : "no egress",
      ),
    ),
  );
}

// ---- views

function renderViews() {
  const g = gadgetById(state.active);
  const show = (el: HTMLElement, on: boolean) => (el.hidden = !on);
  show(emptyView, !g);
  show(appView, !!g && state.view === "app");
  show(codeView, !!g && state.view === "code");
  show(connView, !!g && state.view === "connections");
  show(storageView, !!g && state.view === "storage");
  if (!g) {
    const key = `${state.blueprints.length}`;
    if (emptyView.getAttribute("data-key") !== key) {
      emptyView.setAttribute("data-key", key);
      emptyView.textContent = "";
      emptyView.append(renderEmpty());
    }
    return;
  }
  if (state.view === "code") renderCode(g);
  if (state.view === "connections") renderConnections(g);
  if (state.view === "storage") renderStorage(g);
}

function blueprintCard(bp: BlueprintInfo, onPick: () => void) {
  return h(
    "button",
    { class: "bp", onclick: onPick },
    h("span", { class: "bp__icon" }, icon(bp.icon)),
    h("span", { class: "bp__title" }, bp.title),
    h("span", { class: "bp__desc" }, bp.description),
    h(
      "span",
      { class: "bp__foot" },
      h("span", { class: "chip" }, bp.bindings.length ? `bindings ${bp.bindings.join(", ")}` : "no bindings"),
      h("span", { class: "bp__cta" }, "Create", icon("send", "icon icon-sm")),
    ),
  );
}

async function createFromBlueprint(bp: BlueprintInfo) {
  closeModal();
  if (!session) return;
  const g = await guarded("Could not create the gadget", () => session.createGadget(bp.id));
  if (g) {
    state.active = (g as GadgetInfo).id;
    state.view = "app";
    state.mobile = "gadgets";
    render();
  }
}

function flowDiagram(extraClass = "") {
  const node = (id: string, label: string, title: string, sub: string) =>
    h("div", { class: "node", "data-node": id }, h("div", { class: "node__label" }, label), h("div", { class: "node__title" }, title), h("div", { class: "node__sub" }, sub));
  return h(
    "div",
    { class: `flow ${extraClass}` },
    node("frame", "Browser", "Sandboxed frame", "client.js · opaque origin · connect-src none"),
    node("shell", "Browser", "Shell", "MessagePort ⇄ Cap'n Web"),
    node("worker", "Worker", "PublicApi", "Cap'n Web over one WebSocket"),
    node("workspace", "Durable Object", "Workspace", "SQLite: gadgets, files, chat, actions"),
    node("facet", "Dynamic Worker", "Gadget facet", "LOADER.get() · own SQLite · globalOutbound null"),
    node("gatekeeper", "Gatekeeper", "WEB · AI", "approval queue · allowlist · metering"),
  );
}

function renderEmpty() {
  const blueprints = state.blueprints;
  return h(
    "div",
    { class: "empty" },
    h("span", { class: "eyebrow eyebrow--rule" }, `Workspace ${WS_ID} · Durable Object`),
    h("h1", {}, "Spawn a ", h("span", { class: "accent" }, "gadget"), "."),
    h(
      "p",
      { class: "empty__lede" },
      "Each gadget is a Durable Object class that runs in its own Dynamic Worker, as a facet with a private SQLite database. Its UI runs in a sandboxed frame and talks to the server over Cap'n Web. Start a blueprint, or ask the agent.",
    ),
    h(
      "div",
      { class: "bp-grid" },
      blueprints.map((bp) => blueprintCard(bp, () => void createFromBlueprint(bp))),
      h(
        "button",
        {
          class: "bp bp--agent",
          onclick: () => {
            composerInput.value = "Write a gadget: ";
            state.mobile = "agent";
            render();
            composerInput.focus();
          },
        },
        h("span", { class: "bp__icon" }, icon("sparkle")),
        h("span", { class: "bp__title" }, "Ask the agent"),
        h("span", { class: "bp__desc" }, "Describe an app. The agent writes server.js and client.js, and the platform loads them into a new Dynamic Worker."),
        h("span", { class: "bp__foot" }, h("span", { class: "chip" }, "Workers AI"), h("span", { class: "bp__cta" }, "Write", icon("send", "icon icon-sm"))),
      ),
    ),
    h(
      "div",
      { class: "arch" },
      h("div", { class: "arch__head" }, h("h3", {}, "How a call travels"), h("span", { class: "live-pill" }, "lights up on each live call")),
      flowDiagram(),
      h(
        "div",
        { class: "flow-notes" },
        h("p", { class: "flow-note" }, h("strong", {}, "Isolation. "), "The gadget server has no network, and the frame has no same-origin access. Bindings are capabilities."),
        h("p", { class: "flow-note" }, h("strong", {}, "Live state. "), "Open the share link in a second tab. Callbacks travel back through the same chain, so both tabs update."),
        h("p", { class: "flow-note" }, h("strong", {}, "Hot reload. "), "Save code and the facet restarts on a new Dynamic Worker. Its SQLite database stays."),
      ),
    ),
  );
}

let pulseQueue: ReturnType<typeof setTimeout>[] = [];
function pulseFlow(via: RpcEvent["via"]) {
  const sequence: Record<RpcEvent["via"], string[]> = {
    ui: ["frame", "shell", "worker", "workspace", "facet"],
    agent: ["workspace", "facet"],
    gatekeeper: ["facet", "gatekeeper"],
    platform: ["shell", "worker", "workspace", "facet"],
  };
  pulseQueue.forEach(clearTimeout);
  pulseQueue = [];
  sequence[via].forEach((id, i) => {
    pulseQueue.push(
      setTimeout(() => {
        document.querySelectorAll(`[data-node="${id}"]`).forEach((n) => {
          n.classList.add("hot");
          setTimeout(() => n.classList.remove("hot"), 260);
        });
      }, i * 90),
    );
  });
}

// ---- code

async function loadCode(g: GadgetInfo) {
  const files = (await session.getFiles(g.id)) as GadgetFiles;
  const existing = state.code.get(g.id);
  state.code.set(g.id, { version: g.version, files, drafts: {}, file: existing?.file ?? "client.js" });
  if (state.view === "code" && state.active === g.id) renderCode(g);
}

function renderCode(g: GadgetInfo) {
  const entry = state.code.get(g.id);
  if (!entry || entry.version !== g.version) {
    if (!codeView.querySelector(".spinner")) {
      codeView.textContent = "";
      codeView.append(h("div", { class: "frame-overlay" }, h("div", { class: "spinner" }), "Reading files from the workspace"));
    }
    if (session) void guarded("Could not read files", () => loadCode(g));
    return;
  }
  const existingArea = codeView.querySelector("textarea");
  if (existingArea && codeView.getAttribute("data-key") === `${g.id}:${entry.version}:${entry.file}`) {
    return;
  }
  codeView.setAttribute("data-key", `${g.id}:${entry.version}:${entry.file}`);
  codeView.textContent = "";

  const value = entry.drafts[entry.file] ?? entry.files[entry.file];
  const gutter = h("div", { class: "editor__gutter", "aria-hidden": "true" });
  const area = h("textarea", { spellcheck: "false", "aria-label": `${entry.file} source`, autocapitalize: "off", autocomplete: "off" }) as HTMLTextAreaElement;
  area.value = value;
  const saveBtn = h("button", { class: "btn btn-primary btn-sm" }, icon("save", "icon icon-sm"), "Save and reload") as HTMLButtonElement;
  const dirty = h("span", { class: "dirty-dot", hidden: true, title: "Unsaved changes" });

  const updateGutter = () => {
    const lines = area.value.split("\n").length;
    gutter.textContent = Array.from({ length: lines }, (_, i) => String(i + 1)).join("\n");
    const isDirty = area.value !== entry.files[entry.file];
    dirty.hidden = !isDirty;
    saveBtn.disabled = !isDirty;
  };
  area.addEventListener("input", () => {
    entry.drafts[entry.file] = area.value;
    updateGutter();
  });
  area.addEventListener("scroll", () => (gutter.scrollTop = area.scrollTop));
  area.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: end } = area;
      area.setRangeText("  ", s, end, "end");
      area.dispatchEvent(new Event("input"));
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      saveBtn.click();
    }
  });
  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    const path = entry.file;
    const content = area.value;
    const info = await guarded("Save failed", () => session.writeFile(g.id, path, content));
    if (info) {
      delete entry.drafts[path];
      toast(`Saved ${path}. Version ${(info as GadgetInfo).version} runs in a new Dynamic Worker.`);
      state.view = path === "README.md" ? "code" : "app";
      render();
    } else {
      saveBtn.disabled = false;
    }
  });

  const files: (keyof GadgetFiles)[] = ["client.js", "server.js", "README.md"];
  codeView.append(
    h(
      "div",
      { class: "code" },
      h(
        "div",
        { class: "code__bar" },
        h(
          "div",
          { class: "seg" },
          files.map((f) =>
            h(
              "button",
              {
                "aria-selected": String(entry.file === f),
                onclick: () => {
                  entry.file = f;
                  renderCode(g);
                },
              },
              f,
              entry.drafts[f] !== undefined && entry.drafts[f] !== entry.files[f] ? h("span", { class: "dirty-dot" }) : null,
            ),
          ),
        ),
        h(
          "span",
          { class: "code__note" },
          entry.file === "server.js"
            ? "Durable Object class. Saving loads a new Dynamic Worker. The facet SQLite stays."
            : entry.file === "client.js"
              ? "Runs in the sandboxed frame. Globals: gadget, RpcTarget, gadgetInfo."
              : "The agent reads the Methods list before it calls this gadget.",
        ),
        dirty,
        saveBtn,
      ),
      h("div", { class: "editor" }, gutter, area),
    ),
  );
  updateGutter();
}

// ---- connections

const GATEKEEPERS: { id: BindingName; title: string; desc: string; detail: string; icon: string }[] = [
  {
    id: "WEB",
    title: "WEB gatekeeper",
    icon: "globe",
    desc: "Read-only HTTPS JSON from an allowlist. Each read waits in the approval queue until a person decides.",
    detail: "hn.algolia.com · api.github.com · en.wikipedia.org",
  },
  {
    id: "AI",
    title: "AI gatekeeper",
    icon: "sparkle",
    desc: "Workers AI completions. The platform meters each call against this workspace and a global daily budget.",
    detail: "glm-5.3-flash · max 800 output tokens",
  },
];

function renderConnections(g: GadgetInfo) {
  const snap = state.snap!;
  connView.textContent = "";
  const actions = snap.actions.filter((a) => a.gadget === g.id).slice(0, 8);
  connView.append(
    h(
      "div",
      { class: "panel" },
      h("span", { class: "eyebrow eyebrow--rule" }, `${g.id} · bindings`),
      h("h2", {}, "Connections"),
      h(
        "p",
        { class: "panel__intro" },
        "This gadget runs with ",
        h("code", {}, "globalOutbound: null"),
        ", so fetch() throws. It reaches the outside only through the bindings below. Each binding is a loopback WorkerEntrypoint whose props carry the workspace and gadget identity.",
      ),
      GATEKEEPERS.map((gk) => {
        const connected = g.bindings.includes(gk.id);
        const auto = snap.autoApprove.includes(`${g.id}:${gk.id}`);
        return h(
          "div",
          { class: "card" },
          h(
            "div",
            { class: "card__head" },
            h("span", { class: "card__icon" }, icon(gk.icon)),
            h("div", {}, h("h3", {}, gk.title), h("div", { class: "mono muted", style: "font-size:11.5px" }, `this.env.${gk.id}`)),
            h("span", { style: "flex:1" }),
            h("span", { class: connected ? "chip chip--ok" : "chip" }, connected ? "connected" : "not connected"),
          ),
          h("p", { class: "card__desc" }, gk.desc),
          h(
            "div",
            { class: "card__rows" },
            h(
              "div",
              { class: "row-toggle" },
              h("div", {}, "Connect to this gadget", h("small", {}, "Changes the env, so the gadget restarts in a new Dynamic Worker")),
              h("button", {
                class: "switch",
                role: "switch",
                "aria-checked": String(connected),
                "aria-label": `Connect ${gk.id}`,
                onclick: () => void guarded("Could not change the binding", () => session.setBinding(g.id, gk.id, !connected)),
              }),
            ),
            h(
              "div",
              { class: "row-toggle" },
              h("div", {}, "Approve automatically", h("small", {}, gk.detail)),
              h("button", {
                class: "switch",
                role: "switch",
                "aria-checked": String(auto),
                "aria-label": `Auto-approve ${gk.id}`,
                onclick: () => void guarded("Could not change auto-approval", () => session.setAutoApprove(g.id, gk.id, !auto)),
              }),
            ),
          ),
        );
      }),
      h("div", { class: "section-label" }, "Recent gatekeeper actions for this gadget"),
      actions.length ? h("div", { class: "history" }, actions.map(historyRow)) : h("p", { class: "muted", style: "font-size:13px" }, "No actions yet."),
    ),
  );
}

// ---- storage

let storageTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleStorageRefresh() {
  clearTimeout(storageTimer);
  storageTimer = setTimeout(() => {
    const g = gadgetById(state.active);
    if (g && state.view === "storage") void refreshStorage(g);
  }, 500);
}

async function refreshStorage(g: GadgetInfo) {
  if (!session) return;
  const entry = state.storage.get(g.id) ?? { report: null, loading: false, at: 0 };
  entry.loading = true;
  state.storage.set(g.id, entry);
  try {
    entry.report = (await session.inspectStorage(g.id)) as StorageReport;
    entry.error = undefined;
  } catch (err) {
    entry.error = errMsg(err);
  }
  entry.loading = false;
  entry.at = Date.now();
  if (state.view === "storage" && state.active === g.id) {
    renderStorage(g);
    storageView.querySelector(".live-pill")?.classList.add("pulse");
  }
}

function renderStorage(g: GadgetInfo) {
  const entry = state.storage.get(g.id);
  if (!entry) {
    state.storage.set(g.id, { report: null, loading: true, at: 0 });
    void refreshStorage(g);
  }
  const current = state.storage.get(g.id)!;
  storageView.textContent = "";
  const r = current.report;
  const totalRows = r ? r.tables.reduce((n, t) => n + t.rows, 0) : 0;
  storageView.append(
    h(
      "div",
      { class: "panel" },
      h("span", { class: "eyebrow eyebrow--rule" }, `${g.id} · facet storage`),
      h(
        "div",
        { style: "display:flex;align-items:center;gap:12px;flex-wrap:wrap" },
        h("h2", {}, "Private SQLite"),
        h("span", { class: "live-pill" }, current.loading ? "reading…" : `live · read ${current.at ? clock(current.at) : "—"}`),
        h("span", { style: "flex:1" }),
        h("button", { class: "btn btn-sm", onclick: () => void refreshStorage(g) }, icon("refresh", "icon icon-sm"), "Refresh"),
      ),
      h(
        "p",
        { class: "panel__intro" },
        "The Workspace DO cannot open this database. It asks the facet, through a platform method that the Dynamic Worker's main module adds. The view refreshes after each call to the gadget.",
      ),
      current.error ? h("div", { class: "card", style: "border-color:var(--danger);color:var(--danger)" }, current.error) : null,
      r
        ? [
            h(
              "div",
              { class: "stat-row" },
              stat(String(r.tables.length), "tables"),
              stat(String(totalRows), "rows"),
              stat(String(r.kv.count), "kv keys"),
              stat(r.databaseSize == null ? "—" : `${(r.databaseSize / 1024).toFixed(0)} KB`, "database size"),
            ),
            r.tables.map((t) =>
              h(
                "div",
                { class: "card" },
                h("div", { class: "card__head" }, h("span", { class: "card__icon" }, icon("database")), h("h3", { class: "mono", style: "font-size:14px" }, t.name), h("span", { style: "flex:1" }), h("span", { class: "chip" }, `${t.rows} rows`)),
                t.sample.length
                  ? h(
                      "div",
                      { class: "table-wrap" },
                      h(
                        "table",
                        {},
                        h("thead", {}, h("tr", {}, t.columns.map((c) => h("th", {}, c)))),
                        h("tbody", {}, t.sample.map((row) => h("tr", {}, t.columns.map((c) => h("td", { title: String(row[c] ?? "") }, formatCell(row[c])))))),
                      ),
                    )
                  : h("p", { class: "card__desc" }, "Empty table."),
              ),
            ),
            r.kv.count
              ? h(
                  "div",
                  { class: "card" },
                  h("div", { class: "card__head" }, h("span", { class: "card__icon" }, icon("database")), h("h3", { class: "mono", style: "font-size:14px" }, "ctx.storage.kv"), h("span", { style: "flex:1" }), h("span", { class: "chip" }, `${r.kv.count} keys`)),
                  h(
                    "div",
                    { class: "table-wrap" },
                    h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "key"), h("th", {}, "value"))), h("tbody", {}, r.kv.keys.map((k) => h("tr", {}, h("td", {}, k.key), h("td", { title: k.preview }, k.preview))))),
                  ),
                )
              : null,
          ]
        : null,
    ),
  );
}

function stat(value: string, label: string) {
  return h("div", { class: "stat" }, h("div", { class: "stat__v" }, value), h("div", { class: "stat__l" }, label));
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "string") return v;
  return String(v);
}

// ---- approvals

function renderBanner() {
  bannerHost.textContent = "";
  const pending = pendingActions();
  if (!pending.length || state.drawer === "activity") return;
  const a = pending.at(-1)!;
  const g = gadgetById(a.gadget);
  bannerHost.append(
    h(
      "div",
      { class: "approval-banner", role: "alert" },
      h("span", { class: "card__icon" }, icon("shield")),
      h("div", { class: "approval-banner__text" }, `${g?.title ?? a.gadget} asks the ${a.gatekeeper} gatekeeper: ${a.title}`, h("span", {}, a.detail)),
      h("button", { class: "btn btn-primary btn-sm", onclick: () => void decide(a, true, false) }, "Approve"),
      h("button", { class: "btn btn-sm", onclick: () => toggleDrawer("activity") }, "Review"),
    ),
  );
}

async function decide(a: ActionRecord, approve: boolean, always: boolean) {
  await guarded("Could not record the decision", () => session.decideAction(a.id, approve, always));
}

const STATUS_CHIP: Record<string, string> = { approved: "chip chip--ok", auto: "chip chip--ok", denied: "chip chip--danger", expired: "chip chip--warn", pending: "chip chip--ember" };

function historyRow(a: ActionRecord) {
  return h(
    "div",
    { class: "history__row" },
    h("span", { class: "chip" }, a.gatekeeper),
    h("span", { class: "history__title", title: `${a.title} — ${a.detail}` }, `${a.gadget} · ${a.title}`),
    h("span", { class: STATUS_CHIP[a.status] ?? "chip" }, a.status === "auto" ? "auto" : a.decidedBy ? `${a.status} · ${a.decidedBy.split(" ")[0]}` : a.status),
  );
}

function drawerHead(title: string, sub: string, onClose: () => void) {
  return h(
    "div",
    { class: "pane-head" },
    h("div", {}, h("h2", {}, title)),
    h("span", { class: "chip" }, sub),
    h("span", { class: "pane-head__spacer" }),
    h("button", { class: "icon-btn", "aria-label": "Close", onclick: onClose }, icon("x")),
  );
}

function renderActivity() {
  const snap = state.snap;
  if (!snap) return;
  const pending = pendingActions();
  const history = snap.actions.filter((a) => a.status !== "pending");
  activityDrawer.textContent = "";
  activityDrawer.append(
    drawerHead("Activity", `${pending.length} pending`, () => toggleDrawer(null)),
    h(
      "div",
      { class: "drawer__body" },
      h("p", { class: "muted", style: "font-size:13px" }, "Gatekeepers stop each outside read here. The gadget's call waits until someone in this workspace decides, for up to 90 seconds."),
      h("div", { class: "section-label" }, "Needs review"),
      pending.length
        ? pending.map((a) =>
            h(
              "div",
              { class: "action action--pending" },
              h("div", { class: "action__top" }, h("span", { class: "chip chip--ember" }, a.gatekeeper), h("span", { class: "action__title" }, a.title)),
              h("div", { class: "action__detail" }, `${gadgetById(a.gadget)?.title ?? a.gadget} (${a.gadget}) · ${a.detail}`),
              h(
                "div",
                { class: "action__buttons" },
                h("button", { class: "btn btn-primary btn-sm", onclick: () => void decide(a, true, false) }, icon("check", "icon icon-sm"), "Approve"),
                h("button", { class: "btn btn-sm", onclick: () => void decide(a, true, true) }, "Always allow"),
                h("button", { class: "btn btn-sm btn-danger", onclick: () => void decide(a, false, false) }, "Deny"),
              ),
            ),
          )
        : h("p", { class: "muted", style: "font-size:13px" }, "Nothing waits for approval."),
      h("div", { class: "section-label" }, "History"),
      history.length ? h("div", { class: "history" }, history.map(historyRow)) : h("p", { class: "muted", style: "font-size:13px" }, "No gatekeeper actions yet. Try the Headlines blueprint."),
    ),
  );
}

// ---- system

function renderSystem() {
  const snap = state.snap;
  if (!snap) return;
  const loaderIds = new Set(snap.gadgets.map((g) => g.loaderId));
  systemDrawer.textContent = "";
  systemDrawer.append(
    drawerHead("System", "live", () => toggleDrawer(null)),
    h(
      "div",
      { class: "drawer__body" },
      h("div", { class: "stat-row" }, stat(String(loaderIds.size), "dynamic workers"), stat(String(snap.gadgets.length), "facets"), stat(String(snap.presence.length), "shells"), stat(String(snap.cost.tokensOut + snap.cost.tokensIn), "AI tokens")),
      h("div", { class: "section-label" }, "Call path"),
      h(
        "div",
        { class: "mini-flow" },
        [
          ["frame", "Browser", "Sandboxed frame"],
          ["shell", "Browser", "Shell"],
          ["worker", "Worker", "PublicApi"],
          ["workspace", "Durable Object", "Workspace"],
          ["facet", "Dynamic Worker", "Gadget facet"],
          ["gatekeeper", "Gatekeeper", "WEB · AI"],
        ].map(([id, label, title]) => h("div", { class: "node", "data-node": id! }, h("div", { class: "node__label" }, label!), h("div", { class: "node__title" }, title!))),
      ),
      h("div", { class: "section-label" }, "RPC trace", h("span", { class: "mono", style: "letter-spacing:0;text-transform:none" }, "facet time · your round trip")),
      state.trace.length
        ? h(
            "div",
            { class: "trace" },
            state.trace.slice(0, 60).map((t) =>
              h(
                "div",
                { class: "trace__row", "data-ok": String(t.ok), "data-via": t.via },
                h("span", { class: "trace__time" }, clock(t.at)),
                h("span", { class: "trace__call", title: `${t.gadget}.${t.method}` }, t.via === "gatekeeper" ? `${t.gadget} ${t.method}` : `${t.gadget}.${t.method}()`, h("span", { class: "via" }, ` · ${t.via}${t.who ? ` · ${t.who}` : ""}`)),
                h("span", { class: "trace__ms" }, `${t.ms} ms${t.rtt !== undefined ? ` · ${t.rtt} ms` : ""}`),
              ),
            ),
          )
        : h("p", { class: "muted", style: "font-size:13px" }, "Use a gadget to see calls travel through the facet."),
      h("div", { class: "section-label" }, "Frame console"),
      state.logs.length
        ? h(
            "div",
            { class: "trace" },
            state.logs.slice(0, 30).map((l) =>
              h("div", { class: "trace__row", "data-ok": String(l.level !== "error") }, h("span", { class: "trace__time" }, clock(l.at)), h("span", { class: "trace__call", title: l.message }, `${l.gadget} ${l.message}`), h("span", { class: "trace__ms" }, l.level)),
            ),
          )
        : h("p", { class: "muted", style: "font-size:13px" }, "No console output from gadget frames."),
    ),
  );
}

function toggleDrawer(d: Drawer) {
  state.drawer = state.drawer === d ? null : d;
  render();
}

// ---- mobile

function renderMobileNav() {
  mobileNav.textContent = "";
  const item = (label: string, ic: string, selected: boolean, onclick: () => void, badge = 0) => {
    const b = h("button", { "aria-selected": String(selected), onclick }, icon(ic), label);
    if (badge) b.append(h("span", { class: "badge" }, String(badge)));
    return b;
  };
  mobileNav.append(
    item("Agent", "chat", state.mobile === "agent" && !state.drawer, () => {
      state.mobile = "agent";
      state.drawer = null;
      render();
    }),
    item("Gadgets", "window", state.mobile === "gadgets" && !state.drawer, () => {
      state.mobile = "gadgets";
      state.drawer = null;
      render();
    }),
    item(
      "Activity",
      "shield",
      state.drawer === "activity",
      () => {
        state.mobile = "gadgets";
        toggleDrawer("activity");
      },
      pendingActions().length,
    ),
    item("System", "pulse", state.drawer === "system", () => {
      state.mobile = "gadgets";
      toggleDrawer("system");
    }),
  );
}

// ===================================================================== modals and actions

let scrim: HTMLElement | null = null;
function closeModal() {
  scrim?.remove();
  scrim = null;
}

function openModal(content: HTMLElement) {
  closeModal();
  scrim = h("div", { class: "scrim", onclick: (e: Event) => e.target === scrim && closeModal() }, content);
  document.body.append(scrim);
}

function openBlueprints() {
  const full = (state.snap?.gadgets.length ?? 0) >= (state.snap?.limits.maxGadgets ?? 8);
  openModal(
    h(
      "div",
      { class: "modal", role: "dialog", "aria-label": "Blueprints" },
      h("div", { class: "modal__head" }, h("div", {}, h("span", { class: "eyebrow eyebrow--rule" }, "Blueprints"), h("h2", { style: "margin-top:10px" }, "New gadget")), h("button", { class: "icon-btn", "aria-label": "Close", onclick: closeModal }, icon("x"))),
      h(
        "p",
        { class: "muted" },
        full ? "This workspace has the maximum number of gadgets. Remove one first." : "A blueprint is a server.js, client.js, and README.md snapshot. Creating one copies the files into this workspace.",
      ),
      h("div", { class: "bp-grid" }, state.blueprints.map((bp) => blueprintCard(bp, () => void createFromBlueprint(bp)))),
    ),
  );
}

function openAbout() {
  const rows: [string, string, string][] = [
    ["Workspace", "OverseerDurableObject, typed KV storage, git objects", "Workspace DO with SQLite tables"],
    ["Gadget server", "server.js Durable Object, LOADER.get(), ctx.facets.get()", "Same"],
    ["Gadget UI", "client.js in a sandboxed srcdoc frame, Cap'n Web over MessagePort", "Same"],
    ["Shell ⇄ backend", "One Cap'n Web WebSocket, callback subscriptions", "Same"],
    ["Gatekeepers", "One Worker for each service, OAuth, action journal", "WEB and AI loopback entrypoints with an approval queue"],
    ["Agent", "pi-agent-core, many providers, file tools, Code Mode", "Workers AI glm-5.3-flash with tools"],
    ["Blueprints", "KV and R2, Slides, Docs, Sheets", "Bundled: Slides, Tic-tac-toe, Pixel Board, Headlines"],
    ["Not in the slice", "Git history, OT editing, OAuth, export, hooks, login", "—"],
  ];
  openModal(
    h(
      "div",
      { class: "modal", role: "dialog", "aria-label": "About" },
      h("div", { class: "modal__head" }, h("div", {}, h("span", { class: "eyebrow eyebrow--rule" }, "About this demo"), h("h2", { style: "margin-top:10px" }, "Cloudflare OS, sliced")), h("button", { class: "icon-btn", "aria-label": "Close", onclick: closeModal }, icon("x"))),
      h(
        "p",
        { class: "muted" },
        "Cloudflare OS is an open agent workspace on Workers. This demo keeps its core architecture and runs on a Workers Paid plan: Dynamic Workers, Durable Object facets, Cap'n Web, and gatekeepers. It does not use Workers for Platforms or Containers.",
      ),
      h("div", { class: "table-wrap" }, h("table", { class: "compare" }, h("thead", {}, h("tr", {}, h("th", {}, "Part"), h("th", {}, "Upstream"), h("th", {}, "This slice"))), h("tbody", {}, rows.map((r) => h("tr", {}, r.map((c) => h("td", {}, c))))))),
      h(
        "div",
        { style: "display:flex;gap:8px;margin-top:18px;flex-wrap:wrap" },
        h("a", { class: "btn btn-primary", href: UPSTREAM_URL, target: "_blank", rel: "noopener" }, icon("github", "icon icon-sm"), "cloudflare/cloudflare-os"),
        h("a", { class: "btn", href: "https://github.com/theserverlessdev/tech-demos/tree/main/demos/cloudflare-os", target: "_blank", rel: "noopener" }, "Source of this slice"),
        h("a", { class: "btn", href: HUB_URL }, "All demos"),
      ),
    ),
  );
}

async function share() {
  try {
    await navigator.clipboard.writeText(location.href);
    toast("Link copied. Open it in another tab or browser to join this workspace live.");
  } catch {
    toast(location.href);
  }
}

function newWorkspace() {
  const url = new URL(location.href);
  url.searchParams.set("w", randomId(12));
  location.href = url.toString();
}

function toggleChat() {
  const closed = app.getAttribute("data-chat") === "closed";
  app.setAttribute("data-chat", closed ? "open" : "closed");
  document.getElementById("rail-chat")?.setAttribute("aria-pressed", String(closed));
}

// ===================================================================== wiring

function wire() {
  titleInput.addEventListener("change", () => void guarded("Rename failed", () => session.setTitle(titleInput.value)));
  titleInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") titleInput.blur();
  });
  composerInput.addEventListener("input", autosize);
  composerInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void sendChat();
    }
  });
  sendBtn.addEventListener("click", () => void sendChat());
  activityBtn.addEventListener("click", () => toggleDrawer("activity"));
  systemBtn.addEventListener("click", () => toggleDrawer("system"));
  themeBtn.addEventListener("click", () => {
    const next = theme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("theme", next);
    } catch {}
    themeBtn.textContent = "";
    themeBtn.append(icon(next === "dark" ? "sun" : "moon"));
    for (const entry of frames.values()) entry.iframe.contentWindow?.postMessage({ type: "theme", theme: next }, "*");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (scrim) closeModal();
      else if (state.drawer) toggleDrawer(null);
    }
  });

  // Chat width splitter.
  const saved = Number(localStorage.getItem("cos-chat-w"));
  if (saved >= 280 && saved <= 680) document.documentElement.style.setProperty("--chat-w", `${saved}px`);
  splitter.addEventListener("pointerdown", (e) => {
    splitter.setPointerCapture(e.pointerId);
    splitter.classList.add("dragging");
    frameHost.style.pointerEvents = "none";
    const move = (ev: PointerEvent) => {
      const width = Math.min(680, Math.max(280, ev.clientX - rail.getBoundingClientRect().right));
      document.documentElement.style.setProperty("--chat-w", `${width}px`);
    };
    const up = () => {
      splitter.classList.remove("dragging");
      frameHost.style.pointerEvents = "";
      splitter.removeEventListener("pointermove", move);
      const w = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--chat-w"), 10);
      if (w) localStorage.setItem("cos-chat-w", String(w));
    };
    splitter.addEventListener("pointermove", move);
    splitter.addEventListener("pointerup", up, { once: true });
  });

  // Keep relative times fresh.
  setInterval(() => {
    state.chatSig = "";
    if (state.snap) renderChat(state.snap);
  }, 30_000);
}

function boot() {
  app.textContent = "";
  app.append(topbar, main, mobileNav);
  document.body.append(toasts);
  wire();
  void connect();
}

boot();
