import { AgentClient } from "agents/client";
import {
  RECALL_MIN_SCORE,
  type BrainMessage,
  type DeskMessage,
  type DeskState,
  type Gesture,
  type Inspection,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type RecallHit,
  type TraceEntry,
  type UiStateName,
} from "../shared/protocol";
import { playEffect, Mic, Speaker, audioContext } from "./audio";
import { Face } from "./face";

const FIRMWARE = "browser-sim-0.1";
const BOOTED_AT = Date.now();

// ------------------------------------------------------------------ helpers

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string> = {}, ...children: (Node | string | null)[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") el.className = v;
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c !== null) el.append(c);
  return el;
}

function clock(ms: number) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function countdown(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}:${String(s % 60).padStart(2, "0")}`;
}

// ------------------------------------------------------------------ desk identity

const DESK_RE = /^[a-z0-9]{12,32}$/;
function newDeskId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
}
const url = new URL(location.href);
let deskId = url.searchParams.get("desk") ?? localStorage.getItem("apollo-desk") ?? "";
if (!DESK_RE.test(deskId)) deskId = newDeskId();
localStorage.setItem("apollo-desk", deskId);
if (url.searchParams.get("desk") !== deskId) {
  url.searchParams.set("desk", deskId);
  history.replaceState(null, "", url);
}
const basePath = location.pathname.startsWith("/demos/apollo-desk") ? "demos/apollo-desk/" : "";

$("desk-id").textContent = deskId.slice(0, 8);
$("copy-link").addEventListener("click", async () => {
  await navigator.clipboard?.writeText(location.href).catch(() => {});
  $("desk-id").textContent = "link copied";
  setTimeout(() => ($("desk-id").textContent = deskId.slice(0, 8)), 1400);
});
$("new-desk").addEventListener("click", () => {
  const next = newDeskId();
  localStorage.setItem("apollo-desk", next);
  url.searchParams.set("desk", next);
  location.href = url.toString();
});
$("theme").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("theme", next);
});

// ------------------------------------------------------------------ device pieces

const face = new Face($<HTMLCanvasElement>("face"));
face.start();
const speaker = new Speaker();
const screen = $("screen");
const caption = $("caption");
const led = $("led");

let ui: UiStateName = "idle";
let accent = "#FFFFFF";
let deskState: DeskState | null = null;
let device = { volume: 70, brightness: 80 };
const timers = new Map<string, { label: string; endsAt: number; durationSeconds: number }>();
let pendingConfirm: { id: string; summary: string; expiresAt: number } | null = null;
let turnEnded: { expectsReply: boolean } | null = null;
let dashboardTimer: ReturnType<typeof setInterval> | null = null;
let dashboardData: Extract<BrainMessage, { type: "dashboard" }> | null = null;

function setCaption(text?: string) {
  caption.replaceChildren(text ? h("span", {}, text) : "");
}

function applyUi(msg: Extract<BrainMessage, { type: "ui_state" }>) {
  ui = msg.state;
  accent = msg.accentColor;
  screen.style.setProperty("--accent", accent);
  face.setAccent(accent);
  face.setEmotion(msg.emotion);
  led.dataset.state = msg.state;
  $("mode-label").textContent = msg.speechMode;
  setCaption(pendingConfirm ? undefined : msg.caption);
  const dash = msg.state === "dashboard";
  $("dashboard").hidden = !dash;
  face.setHidden(dash || !!pendingConfirm);
  if (dash) renderDashboard();
  else if (dashboardTimer) {
    clearInterval(dashboardTimer);
    dashboardTimer = null;
  }
}

function renderDashboard() {
  const data = dashboardData;
  const tz = data?.clock.timezone ?? "UTC";
  const draw = () => {
    const now = new Date();
    const time = now.toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" });
    const date = now.toLocaleDateString("en-GB", { timeZone: tz, weekday: "long", day: "numeric", month: "long" });
    const wx = data?.weather;
    $("dashboard").replaceChildren(
      h("div", { class: "clock" }, time),
      h("div", { class: "date" }, `${date} · ${tz}`),
      wx
        ? h("div", { class: "wx" }, h("strong", {}, `${wx.temperatureC}°`), wx.conditionLabel, h("div", { class: "wx-place" }, wx.locationLabel))
        : h("div", { class: "wx wx-place" }, "Say “set my location to Lisbon” for weather."),
    );
  };
  draw();
  dashboardTimer ??= setInterval(draw, 10_000);
}

function showConfirm(c: { id: string; summary: string; expiresAt: number } | null) {
  pendingConfirm = c;
  $("confirm").hidden = !c;
  if (c) $("confirm-summary").textContent = c.summary;
  face.setHidden(!!c || ui === "dashboard");
  if (c) setCaption("");
}

function applyDevice() {
  speaker.setVolume(device.volume / 100);
  $("vol-bar").style.width = `${device.volume}%`;
  screen.style.filter = `brightness(${0.35 + (device.brightness / 100) * 0.65})`;
}
applyDevice();

// Timer arc and top label, plus the mouth and ring levels.
function tick() {
  const now = Date.now();
  let soonest: { label: string; endsAt: number; durationSeconds: number } | null = null;
  for (const t of timers.values()) if (!soonest || t.endsAt < soonest.endsAt) soonest = t;
  if (pendingConfirm) {
    const left = (pendingConfirm.expiresAt - now) / 1000;
    face.setTimer(Math.max(0, left / 30));
    $("screen-top").textContent = `confirm · ${Math.max(0, Math.ceil(left))}s`;
  } else if (soonest) {
    const left = (soonest.endsAt - now) / 1000;
    face.setTimer(Math.max(0, Math.min(1, left / soonest.durationSeconds)));
    $("screen-top").textContent = `${soonest.label} · ${countdown(left)}`;
  } else {
    face.setTimer(null);
    $("screen-top").textContent = "";
  }
  if (speaker.endsAt && now > speaker.endsAt) speaker.skip();
  face.setLevel(talking ? mic.level : speaker.level());
  drawLevel();
  requestAnimationFrame(tick);
}

// ------------------------------------------------------------------ connection

const client = new AgentClient<DeskState>({
  agent: "Apollo",
  name: deskId,
  host: location.host,
  protocol: location.protocol === "https:" ? "wss" : "ws",
  basePath: `${basePath}agents/apollo/${deskId}`,
  onStateUpdate: (state) => {
    deskState = state;
    device = { volume: state.device.volume, brightness: state.device.brightness };
    applyDevice();
    renderState();
  },
});
client.binaryType = "arraybuffer";

const conn = $("conn");
client.addEventListener("open", () => {
  conn.dataset.state = "open";
  $("conn-label").textContent = "Connected";
  send({ type: "hello", deviceId: `browser-${deskId.slice(0, 6)}`, firmwareVersion: FIRMWARE, ts: Date.now() });
  void refresh();
});
client.addEventListener("close", () => {
  conn.dataset.state = "closed";
  $("conn-label").textContent = "Reconnecting";
});

function send(msg: DeskMessage) {
  client.send(JSON.stringify(msg));
  logWire("up", msg);
}

let tts: { sequence: number; bytes: number; chunks: Uint8Array[] } | null = null;
let binaryDown = 0;

client.addEventListener("message", (ev: MessageEvent) => {
  if (typeof ev.data !== "string") {
    const bytes = new Uint8Array(ev.data as ArrayBuffer);
    binaryDown += bytes.byteLength;
    tts?.chunks.push(bytes);
    return;
  }
  let msg: BrainMessage | { type: string };
  try {
    msg = JSON.parse(ev.data);
  } catch {
    return;
  }
  if (!msg.type || msg.type.startsWith("cf_agent") || msg.type === "rpc") return;
  if (msg.type !== "trace") logWire("down", msg);
  handle(msg as BrainMessage);
});

function handle(msg: BrainMessage) {
  switch (msg.type) {
    case "ui_state":
      if (msg.state !== "speaking" || !speaker.playing) turnEnded = null;
      return applyUi(msg);
    case "tts_start":
      tts = { sequence: msg.sequence, bytes: msg.bytes, chunks: [] };
      return;
    case "tts_end": {
      if (!tts || tts.sequence !== msg.sequence) return;
      const joined = new Uint8Array(tts.chunks.reduce((n, c) => n + c.byteLength, 0));
      let o = 0;
      for (const c of tts.chunks) {
        joined.set(c, o);
        o += c.byteLength;
      }
      tts = null;
      speaker.enqueue(joined, afterSpeech);
      return;
    }
    case "tts_aborted":
      tts = null;
      speaker.stop();
      return;
    case "turn_end":
      turnEnded = { expectsReply: msg.expectsReply };
      // With the volume at 0 no audio comes, so keep the caption up long enough to read.
      if (!speaker.playing) setTimeout(() => !speaker.playing && afterSpeech(), Math.max(2500, (caption.textContent ?? "").length * 45));
      void refresh();
      return;
    case "timer":
      timers.set(msg.id, { label: msg.label, endsAt: msg.endsAt, durationSeconds: msg.durationSeconds });
      void refresh();
      return;
    case "timer_clear":
      timers.delete(msg.id);
      return;
    case "confirm_request":
      showConfirm(msg);
      return;
    case "confirm_close":
      if (pendingConfirm?.id === msg.id) showConfirm(null);
      void refresh();
      return;
    case "dashboard":
      dashboardData = msg;
      return;
    case "reminder":
      addTraceNote(`Reminder: ${msg.message}`);
      return;
    case "play_effect":
      playEffect(msg.name, device.volume / 100);
      return;
    case "error":
      hint(msg.message, true);
      return;
    case "mcp":
      return answerMcp(msg.payload);
    case "trace":
      return addTrace(msg.entry);
  }
}

/** After the speaker stops, the desk goes back to idle. A question keeps the face curious and focuses the text box. */
function afterSpeech() {
  const ended = turnEnded;
  if (!ended || ui !== "speaking") return;
  turnEnded = null;
  applyUi({
    type: "ui_state",
    state: ended.expectsReply ? "listening" : "idle",
    speechMode: deskState?.speechMode ?? "default",
    emotion: ended.expectsReply ? "curious" : "neutral",
    accentColor: accent,
    caption: ended.expectsReply ? caption.textContent ?? "" : undefined,
  });
  if (ended.expectsReply) $("say-input").focus({ preventScroll: true });
}

// ------------------------------------------------------------------ the desk MCP server

/** Upstream firmware runs an MCP server. The brain calls it with JSON-RPC in `mcp` frames. */
function answerMcp(req: JsonRpcRequest) {
  const reply = (result: JsonRpcResponse["result"], error?: JsonRpcResponse["error"]) =>
    send({ type: "mcp", payload: error ? { jsonrpc: "2.0", id: req.id, error } : { jsonrpc: "2.0", id: req.id, result }, ts: Date.now() });
  const text = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
  const status = () => ({ volume: device.volume, brightness: device.brightness, firmwareVersion: FIRMWARE, uptimeSeconds: Math.round((Date.now() - BOOTED_AT) / 1000), battery: "USB power" });

  if (req.method === "tools/list") {
    return reply({
      tools: [
        { name: "self.get_device_status", description: "Volume, brightness, firmware, uptime" },
        { name: "self.audio_speaker.set_volume", description: "Set speaker volume 0-100" },
        { name: "self.screen.set_brightness", description: "Set screen brightness 0-100" },
      ],
    });
  }
  if (req.method !== "tools/call") return reply(undefined, { code: -32601, message: `Unknown method ${req.method}` });
  const { name, arguments: args = {} } = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
  const clamp = (v: unknown) => Math.max(0, Math.min(100, Math.round(Number(v))));
  switch (name) {
    case "self.get_device_status":
      return reply(text(status()));
    case "self.audio_speaker.set_volume":
      if (!Number.isFinite(Number(args.volume))) return reply({ ...text("volume must be a number"), isError: true });
      device.volume = clamp(args.volume);
      applyDevice();
      return reply(text(status()));
    case "self.screen.set_brightness":
      if (!Number.isFinite(Number(args.brightness))) return reply({ ...text("brightness must be a number"), isError: true });
      device.brightness = clamp(args.brightness);
      applyDevice();
      return reply(text(status()));
    default:
      return reply({ ...text(`Unknown tool ${name}`), isError: true });
  }
}

// ------------------------------------------------------------------ controls

function hint(text: string, error = false) {
  const el = $("talk-hint");
  el.textContent = text;
  el.dataset.tone = error ? "error" : "";
  if (error) {
    clearTimeout((hint as { t?: ReturnType<typeof setTimeout> }).t);
    (hint as { t?: ReturnType<typeof setTimeout> }).t = setTimeout(() => hint("Hold the button or the space bar while you speak. Release to send."), 6000);
  }
}

const mic = new Mic((pcm) => {
  if (talking) {
    client.send(pcm);
    binaryUp += pcm.byteLength;
  }
});
let talking = false;
let binaryUp = 0;
const talk = $<HTMLButtonElement>("talk");

async function startTalk() {
  if (talking) return;
  audioContext();
  if (!mic.supported) return hint("This browser has no microphone access. Type to Apollo.", true);
  speaker.stop();
  talking = true;
  talk.dataset.active = "true";
  $("talk-label").textContent = "Listening";
  binaryUp = 0;
  try {
    await mic.start();
    if (!talking) return mic.stop();
    send({ type: "hold_start", ts: Date.now() });
  } catch {
    talking = false;
    talk.dataset.active = "false";
    $("talk-label").textContent = "Hold to talk";
    hint("The microphone is blocked. Allow it in the address bar, or type to Apollo.", true);
  }
}

function endTalk() {
  if (!talking) return;
  talking = false;
  mic.stop();
  talk.dataset.active = "false";
  $("talk-label").textContent = "Hold to talk";
  send({ type: "hold_end", ts: Date.now() });
  logWireNote(`↑ ${Math.round(binaryUp / 1024)} KB of 16 kHz PCM in binary frames`);
}

talk.addEventListener("pointerdown", (e) => {
  talk.setPointerCapture(e.pointerId);
  void startTalk();
});
talk.addEventListener("pointerup", endTalk);
talk.addEventListener("pointercancel", endTalk);
talk.addEventListener("contextmenu", (e) => e.preventDefault());
window.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || e.repeat || (e.target as HTMLElement).matches("input, textarea, button")) return;
  e.preventDefault();
  void startTalk();
});
window.addEventListener("keyup", (e) => {
  if (e.code === "Space" && talking) {
    e.preventDefault();
    endTalk();
  }
});

const levelCanvas = $<HTMLCanvasElement>("level");
const levelCtx = levelCanvas.getContext("2d")!;
function drawLevel() {
  levelCtx.clearRect(0, 0, 120, 24);
  if (!talking) return;
  levelCtx.fillStyle = "#fff";
  const bars = 12;
  for (let i = 0; i < bars; i++) {
    const on = i / bars < mic.level;
    levelCtx.globalAlpha = on ? 1 : 0.3;
    levelCtx.fillRect(i * 10, 4, 6, 16);
  }
  levelCtx.globalAlpha = 1;
}

$("say").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("say-input");
  const text = input.value.trim();
  if (!text) return;
  audioContext();
  speaker.stop();
  send({ type: "text_input", text, ts: Date.now() });
  input.value = "";
});

document.querySelectorAll<HTMLButtonElement>("[data-gesture]").forEach((b) =>
  b.addEventListener("click", () => {
    audioContext();
    gesture(b.dataset.gesture as Gesture);
  }),
);

function gesture(g: Gesture) {
  if (g === "double_tap") speaker.stop();
  send({ type: "gesture", gesture: g, ts: Date.now() });
}

// The screen is a touch surface: a tap opens the dashboard and a horizontal drag is a swipe.
let press: { x: number; y: number; t: number } | null = null;
let lastTap = 0;
screen.addEventListener("pointerdown", (e) => {
  if ((e.target as HTMLElement).closest("button")) return;
  press = { x: e.clientX, y: e.clientY, t: Date.now() };
});
screen.addEventListener("pointerup", (e) => {
  if (!press) return;
  const dx = e.clientX - press.x;
  const dy = e.clientY - press.y;
  press = null;
  audioContext();
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) return gesture(dx > 0 ? "swipe_right" : "swipe_left");
  if (Math.hypot(dx, dy) > 12) return;
  const now = Date.now();
  if (now - lastTap < 320) {
    lastTap = 0;
    return gesture("double_tap");
  }
  lastTap = now;
  setTimeout(() => {
    if (lastTap === now) gesture("tap");
  }, 330);
});

$("confirm-yes").addEventListener("click", () => send({ type: "confirm", ok: true, ts: Date.now() }));
$("confirm-no").addEventListener("click", () => send({ type: "confirm", ok: false, ts: Date.now() }));

const CHIPS = [
  "Remember that I drink jasmine tea with no sugar",
  "Set a 1 minute timer for my tea",
  "Set my location to Lisbon",
  "What's the weather like?",
  "Add oat milk and lemons to my groceries list",
  "Turn the volume down to 40",
  "What do you remember about me?",
  "Switch to nerd mode",
  "Forget everything about me",
];
$("chips").replaceChildren(
  ...CHIPS.map((text) => {
    const b = h("button", { class: "chip", type: "button" }, text);
    b.addEventListener("click", () => {
      audioContext();
      speaker.stop();
      send({ type: "text_input", text, ts: Date.now() });
    });
    return b;
  }),
);

// ------------------------------------------------------------------ console

document.querySelectorAll<HTMLButtonElement>(".tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    document.querySelectorAll<HTMLButtonElement>(".tab").forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
    document.querySelectorAll<HTMLElement>(".panel").forEach((p) => (p.hidden = p.dataset.panel !== tab.dataset.tab));
  }),
);

let inspection: Inspection | null = null;
let firstLoad = true;
let refreshing: Promise<void> | null = null;

async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      inspection = (await client.call("inspect", [])) as Inspection;
      renderInspection(inspection);
    } catch (err) {
      console.warn("inspect failed", err);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

function renderInspection(data: Inspection) {
  const list = $("transcript");
  if (!data.messages.length) {
    list.replaceChildren(h("li", { class: "empty" }, "No messages yet. Hold to talk, type, or pick a suggested turn above."));
  } else {
    let thread = -1;
    const items: HTMLElement[] = [];
    for (const m of data.messages) {
      if (m.thread !== thread) {
        thread = m.thread;
        items.push(h("li", { class: "thread" }, `Thread ${thread}`));
      }
      items.push(
        h(
          "li",
          { class: "msg", "data-role": m.role },
          h("span", { class: "msg__who" }, m.role === "user" ? "You" : "Apollo"),
          h("span", { class: "msg__text" }, m.content, h("span", { class: "msg__time" }, clock(m.created_at))),
        ),
      );
    }
    list.replaceChildren(...items);
    const panel = list.closest(".panel")!;
    panel.scrollTop = panel.scrollHeight;
  }
  if (firstLoad) {
    firstLoad = false;
    $("talk-note").textContent = data.messages.length
      ? `Loaded ${plural(data.messages.length, "message")} and ${plural(data.facts.length, "fact")} from this desk's SQLite after the page load. The Durable Object kept them.`
      : "Messages come from this desk's SQLite table. Refresh the page and they stay.";
  }

  $("facts-count").textContent = String(data.facts.length);
  $("facts").replaceChildren(
    ...(data.facts.length
      ? data.facts.map((f) => h("li", {}, h("span", {}, f.fact), h("span", { class: "dims" }, `${f.dims}d · #${f.id}`)))
      : [h("li", { class: "empty" }, "No facts yet. Tell Apollo something about you.")]),
  );

  renderSchedules(data);
  const now = Date.now();
  // Frames can go missing while the socket is down, so the server's rows are the truth.
  const live = new Set(data.schedules.map((s) => s.id));
  for (const id of timers.keys()) if (!live.has(id)) timers.delete(id);
  for (const s of data.schedules) {
    if (s.kind === "timer" && s.time > now && !timers.has(s.id)) timers.set(s.id, { label: s.label, endsAt: s.time, durationSeconds: Math.max(5, (s.time - now) / 1000) });
  }

  const groups = new Map<string, string[]>();
  for (const item of data.list) groups.set(item.list, [...(groups.get(item.list) ?? []), item.item]);
  $("lists").replaceChildren(
    ...(groups.size
      ? [...groups].map(([name, items]) => h("li", {}, h("span", {}, `${name}: ${items.join(", ")}`), h("span", { class: "meta" }, `${items.length}`)))
      : [h("li", { class: "empty" }, "No lists yet.")]),
  );

  const own = new Set(["messages", "memories", "list_items", "pending_confirmations", "pending_device_messages"]);
  $("tables").replaceChildren(
    ...data.tables.map((t) => h("li", { "data-own": String(own.has(t.name)) }, h("span", {}, t.name), h("span", {}, String(t.rows)))),
  );
  $("budget").textContent = `Shared Workers AI budget today: $${data.budget.spent.toFixed(4)} of $${data.budget.budget.toFixed(2)}.`;
  if (data.pendingConfirm && pendingConfirm?.id !== data.pendingConfirm.id) showConfirm(data.pendingConfirm);
  if (!data.pendingConfirm && pendingConfirm) showConfirm(null);
}

function renderSchedules(data: Inspection) {
  const now = Date.now();
  $("schedules").replaceChildren(
    ...(data.schedules.some((s) => s.time > now)
      ? data.schedules.filter((s) => s.time > now).map((s) => h("li", {}, h("span", {}, `${s.kind}: ${s.label}`), h("span", { class: "meta" }, `in ${countdown((s.time - now) / 1000)}`)))
      : [h("li", { class: "empty" }, "Nothing scheduled.")]),
  );
}

function renderState() {
  if (!deskState) return;
  const s = deskState;
  const rows: [string, string][] = [
    ["Speech mode", s.speechMode],
    ["Location", s.location ? `${s.location.label} (${s.location.timezone})` : "not set"],
    ["Thread", String(s.thread)],
    ["Turns", String(s.turns)],
    ["Last turn", s.lastTurnAt ? clock(s.lastTurnAt) : "never"],
    ["Desk", `volume ${s.device.volume}, brightness ${s.device.brightness}, ${s.device.firmwareVersion}`],
  ];
  $("state").replaceChildren(...rows.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]));
}

$("probe").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $<HTMLInputElement>("probe-input").value.trim();
  if (q.length < 2) return;
  const out = $("scores");
  out.replaceChildren(h("li", { class: "empty" }, "Scoring…"));
  try {
    const hits = (await client.call("probeMemory", [q])) as RecallHit[];
    out.replaceChildren(
      ...(hits.length
        ? hits.map((hit) => {
            const pct = Math.max(0, Math.min(1, (hit.score - 0.3) / 0.7));
            const bar = h("span", { class: "bar" }, h("span", { style: `width:${Math.round(pct * 100)}%` }));
            return h("li", { "data-hit": String(hit.via === "vector" && hit.score >= RECALL_MIN_SCORE) }, h("span", {}, hit.fact), bar, h("span", { class: "num" }, hit.score.toFixed(2)));
          })
        : [h("li", { class: "empty" }, "No facts to score yet.")]),
    );
  } catch (err) {
    out.replaceChildren(h("li", { class: "empty" }, err instanceof Error ? err.message : "The probe failed."));
  }
});

// Trace
const trace = $("trace");
function addTraceRow(kind: string, detail: Node, meta = "", attrs: Record<string, string> = {}) {
  trace.append(h("li", { "data-kind": kind, ...attrs }, h("span", { class: "kind" }, kind), h("span", { class: "detail" }, detail), h("span", { class: "ms" }, meta)));
  while (trace.children.length > 200) trace.firstChild?.remove();
  const panel = trace.closest(".panel")!;
  panel.scrollTop = panel.scrollHeight;
}
function addTraceNote(text: string) {
  trace.append(h("li", { class: "turn-sep" }, text));
}
function detail(main: string, sub?: string) {
  const span = document.createDocumentFragment();
  span.append(main);
  if (sub) span.append(h("small", {}, sub));
  return span;
}

function addTrace(e: TraceEntry) {
  switch (e.kind) {
    case "heard":
      addTraceNote(`Turn at ${clock(Date.now())}`);
      return addTraceRow("speech", detail(`“${e.text || "(silence)"}”`, `whisper-large-v3-turbo · ${e.seconds}s of audio`));
    case "recall":
      if (!trace.lastElementChild?.matches("[data-kind='speech']")) addTraceNote(`Turn at ${clock(Date.now())}`);
      return addTraceRow(
        "recall",
        detail(e.facts.length ? e.facts.map((f) => f.fact).join(" · ") : "No stored fact matched.", e.facts.map((f) => `${f.via} ${f.score.toFixed(2)}`).join("  ")),
      );
    case "model":
      return addTraceRow("model", detail(`Round ${e.round}: ${e.tokensIn} tokens in, ${e.tokensOut} out`, `${e.model.replace("@cf/", "")} · $${e.usd.toFixed(5)}`), `${e.ms} ms`);
    case "tool":
      return addTraceRow("tool", detail(`${e.name}(${e.args})`, `${e.safety === "unsafe" ? "unsafe · " : ""}${e.result}`), `${e.ms} ms`, { "data-ok": String(e.ok) });
    case "tts":
      return addTraceRow(
        "speech",
        detail(`${e.chars} characters to ${Math.round(e.bytes / 1024)} KB of WAV`, `${e.model.replace("@cf/", "")} · ${plural(e.segments, "segment")}${e.failed ? ` · ${e.failed} failed` : ""}`),
        `${e.ms} ms`,
      );
    case "thread":
      return addTraceNote(`Thread ${e.thread} started after ${e.reason}.`);
  }
}

// Wire
const wire = $("wire");
function logWire(dir: "up" | "down", msg: { type: string }) {
  const { type, ...rest } = msg as { type: string; ts?: number };
  delete rest.ts;
  let body = JSON.stringify(rest);
  if (body.length > 260) body = `${body.slice(0, 260)}…`;
  if (type === "tts_end") body += `  (${Math.round(binaryDown / 1024)} KB of audio in binary frames)`;
  if (type === "tts_start") binaryDown = 0;
  wire.append(
    h(
      "li",
      {},
      h("span", { class: "t" }, clock(Date.now())),
      h("span", { class: dir === "up" ? "dir-up" : "dir-down" }, dir === "up" ? "↑" : "↓"),
      h("span", { class: "body" }, h("b", {}, type), " ", body === "{}" ? "" : body),
    ),
  );
  while (wire.children.length > 300) wire.firstChild?.remove();
  const panel = wire.closest(".panel")!;
  if (!panel.hasAttribute("hidden")) panel.scrollTop = panel.scrollHeight;
}
function logWireNote(text: string) {
  wire.append(h("li", {}, h("span", { class: "t" }, clock(Date.now())), h("span", {}, ""), h("span", { class: "body" }, text)));
}

setInterval(() => {
  if (inspection?.schedules.length) renderSchedules(inspection);
}, 1000);
requestAnimationFrame(tick);
