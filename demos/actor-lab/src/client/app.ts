import { isTurnstileApi, TURNSTILE_RACE, TURNSTILE_UNLOCK } from "../shared/guards";
import type { LabConfig, RaceMode, RaceResult, RoomResponse, RoomView, ServerEvent } from "../shared/types";

const API_BASE = location.pathname.startsWith("/demos/actor-lab") ? "/demos/actor-lab" : "";
const PING_MS = 25_000;

type TurnstileApi = {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      action: string;
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
    },
  ) => string;
  reset: (id: string) => void;
  getResponse: (id: string) => string;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const statusEl = must<HTMLElement>("status");
const fireBtn = must<HTMLButtonElement>("fire");
const timeline = must<HTMLElement>("timeline");
const tableBody = must<HTMLElement>("table").querySelector("tbody");
const score = must<HTMLElement>("score");
let n = 4;
let raceWidgetId = "";
let unlockWidgetId = "";
let siteKey = "";
let aiReady = false;
let raceReady = false;
let unlockReady = false;
let roomCode = "";
let socket: WebSocket | null = null;
let scratchTimer = 0;
let scratchFromUs = false;
let pendingSay = "";
let reconnectTimer = 0;
let reconnectAttempt = 0;
let pingTimer = 0;
let wantSocket = false;

function must<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}

function setStatus(text: string): void {
  statusEl.textContent = text;
}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const res = await fetch(`${API_BASE}${path}`, { method: init.method ?? "GET", headers, body });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = isRecord(data) && isRecord(data.error) && typeof data.error.message === "string" ? data.error.message : `Request failed (${res.status}).`;
    throw new Error(err);
  }
  return data as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mode(): RaceMode {
  const picked = document.querySelector<HTMLInputElement>('input[name="mode"]:checked');
  return picked?.value === "serialized" ? "serialized" : "interleaved";
}

function tokenOf(widgetId: string): string {
  const api = turnstileApi();
  if (!widgetId || !api) return "";
  return api.getResponse(widgetId) || "";
}

function resetWidget(widgetId: string, ready: (value: boolean) => void): void {
  const api = turnstileApi();
  if (widgetId && api) {
    try {
      api.reset(widgetId);
    } catch {
      // Widget already gone.
    }
  }
  ready(false);
}

function turnstileApi(): TurnstileApi | null {
  const api = window.turnstile;
  return isTurnstileApi(api) ? api : null;
}

function syncFire(): void {
  fireBtn.disabled = !aiReady || !raceReady;
  const unlock = document.getElementById("unlock");
  if (unlock instanceof HTMLButtonElement) unlock.disabled = !aiReady || !unlockReady || !roomCode;
}

async function waitTurnstile(): Promise<TurnstileApi | null> {
  for (let i = 0; i < 50; i++) {
    const api = turnstileApi();
    if (api && typeof api.render === "function") return api;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

function renderRace(result: RaceResult): void {
  must<HTMLElement>("score-expected").textContent = String(result.expected);
  must<HTMLElement>("score-actual").textContent = String(result.actual);
  const lost = must<HTMLElement>("score-lost");
  lost.textContent = String(result.lost);
  lost.style.color = result.lost > 0 ? "var(--danger)" : "var(--ok)";
  score.hidden = false;
  const source =
    result.awaitSource === "workers-ai"
      ? "Waits were Workers AI."
      : result.awaitSource === "fallback-delay"
        ? "Workers AI was unavailable, so the waits were a timed pause. The input gate still opened."
        : result.awaitSource === "mixed"
          ? "Some waits were Workers AI and some were a timed pause."
          : "";
  must<HTMLElement>("summary").textContent = `${result.summary} ${source}`.trim();
  renderTimeline(result);
  renderTable(result);
}

function renderTimeline(result: RaceResult): void {
  timeline.replaceChildren();
  const times = result.events.map((event) => event.at);
  if (!times.length || !tableBody) {
    timeline.textContent = "No events came back.";
    return;
  }
  const min = Math.min(...times);
  const span = Math.max(1, Math.max(...times) - min);
  const racers = [...new Set(result.events.map((event) => event.racer))].sort((a, b) => a - b);
  for (const racer of racers) {
    const lane = document.createElement("div");
    lane.className = "lane";
    const label = document.createElement("span");
    label.textContent = `Racer ${racer + 1}`;
    const track = document.createElement("div");
    track.className = "track";
    const mine = result.events.filter((event) => event.racer === racer);
    const start = mine.find((event) => event.phase === "await-start");
    const end = mine.find((event) => event.phase === "await-end");
    const read = mine.find((event) => event.phase === "read");
    const write = mine.find((event) => event.phase === "write");
    if (start && end) {
      const bar = document.createElement("i");
      bar.className = "wait";
      bar.style.left = `${((start.at - min) / span) * 100}%`;
      bar.style.width = `${Math.max(1.5, ((end.at - start.at) / span) * 100)}%`;
      track.append(bar);
    }
    if (read) track.append(mark("read", read.at, min, span));
    if (write) track.append(mark("write", write.at, min, span));
    lane.append(label, track);
    timeline.append(lane);
  }
}

function mark(kind: "read" | "write", at: number, min: number, span: number): HTMLElement {
  const el = document.createElement("i");
  el.className = `mark ${kind}`;
  el.style.left = `${((at - min) / span) * 100}%`;
  return el;
}

function renderTable(result: RaceResult): void {
  if (!tableBody) return;
  tableBody.replaceChildren();
  const racers = [...new Set(result.events.map((event) => event.racer))].sort((a, b) => a - b);
  for (const racer of racers) {
    const mine = result.events.filter((event) => event.racer === racer);
    const read = mine.find((event) => event.phase === "read");
    const start = mine.find((event) => event.phase === "await-start");
    const end = mine.find((event) => event.phase === "await-end");
    const write = mine.find((event) => event.phase === "write");
    const wait = start && end ? `${end.at - start.at} ms · ${end.source || "wait"}` : "—";
    const row = document.createElement("tr");
    for (const value of [`${racer + 1}`, read ? String(read.counter) : "—", wait, write ? String(write.counter) : "—"]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    tableBody.append(row);
  }
}

async function fire(): Promise<void> {
  setStatus("");
  fireBtn.disabled = true;
  try {
    const armed = await call<{ runId: string }>("/api/race/arm", {
      method: "POST",
      body: { n, mode: mode(), token: tokenOf(raceWidgetId) },
    });
    await Promise.all(
      Array.from({ length: n }, (_, racer) => call("/api/race/step", { method: "POST", body: { runId: armed.runId, racer } })),
    );
    const result = await call<RaceResult>(`/api/race/result?runId=${encodeURIComponent(armed.runId)}`);
    renderRace(result);
  } catch (err) {
    setStatus(err instanceof Error ? err.message : "The race failed.");
  } finally {
    resetWidget(raceWidgetId, (value) => {
      raceReady = value;
    });
    syncFire();
  }
}

function memoryLabel(memory: RoomView["memory"]): string {
  if (memory === "reloaded") return "Reloaded after evict";
  if (memory === "woke") return "Woke from SQLite";
  return "Fresh isolate";
}

function renderRoom(room: RoomView, code = roomCode): void {
  must<HTMLElement>("room").hidden = false;
  must<HTMLElement>("room-code").textContent = code;
  must<HTMLElement>("memory").textContent = memoryLabel(room.memory);
  must<HTMLElement>("peers").textContent = room.peers === 1 ? "1 socket" : `${room.peers} sockets`;
  const expires = new Date(room.expiresAt);
  const unlock = room.aiUntil > Date.now() ? `AI replies unlocked until ${new Date(room.aiUntil).toLocaleTimeString()}.` : "AI replies are locked until you unlock them.";
  must<HTMLElement>("room-hint").textContent =
    `Transcript is SQLite. Scratch is isolate memory. It also disappears by itself when the room hibernates after about 10 seconds with no messages. Simulate evict does the same on demand. Room expires ${expires.toLocaleTimeString()} if it stays quiet. ${unlock}`;
  const list = must<HTMLOListElement>("transcript");
  list.replaceChildren();
  if (!room.messages.length) {
    const empty = document.createElement("li");
    empty.textContent = "No messages yet.";
    list.append(empty);
  }
  for (const message of room.messages) {
    const item = document.createElement("li");
    if (message.role === "actor") item.className = "actor";
    const who = document.createElement("span");
    who.className = "who";
    const via = message.source === "fallback" ? " · fallback" : message.source === "workers-ai" ? " · workers-ai" : "";
    who.textContent = `${message.name}${via}`;
    const body = document.createElement("span");
    body.textContent = message.text;
    item.append(who, body);
    list.append(item);
  }
  list.scrollTop = list.scrollHeight;
  const scratch = must<HTMLTextAreaElement>("scratch");
  if (document.activeElement !== scratch && scratch.value !== room.scratch) scratch.value = room.scratch;
  void mountUnlockWidget();
}

function applyEvent(event: ServerEvent): void {
  if (event.type === "error") {
    setStatus(event.message);
    if (pendingSay) {
      must<HTMLInputElement>("message").value = pendingSay;
      pendingSay = "";
    }
    return;
  }
  if (event.type === "peers") {
    must<HTMLElement>("peers").textContent = event.peers === 1 ? "1 socket" : `${event.peers} sockets`;
    return;
  }
  if (event.type === "scratch") {
    const scratch = must<HTMLTextAreaElement>("scratch");
    if (scratchFromUs && scratch.value === event.text) return;
    if (document.activeElement !== scratch) scratch.value = event.text;
    return;
  }
  if (event.type === "said") {
    const nick = must<HTMLInputElement>("nick").value.trim() || "Guest";
    if (pendingSay && event.human.name === nick && event.human.text === pendingSay) {
      must<HTMLInputElement>("message").value = "";
      pendingSay = "";
    }
    renderRoom(event.room);
    return;
  }
  if (event.type === "hello" || event.type === "evicted") renderRoom(event.room);
}

function stopPing(): void {
  if (pingTimer) window.clearInterval(pingTimer);
  pingTimer = 0;
}

function startPing(ws: WebSocket): void {
  stopPing();
  pingTimer = window.setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send("ping");
  }, PING_MS);
}

function connect(code: string): void {
  socket?.close();
  wantSocket = true;
  const nick = must<HTMLInputElement>("nick").value.trim() || "Guest";
  const url = new URL(`${API_BASE}/api/rooms/${code}/socket`, location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("name", nick);
  const next = new WebSocket(url);
  socket = next;
  next.addEventListener("open", () => {
    reconnectAttempt = 0;
    startPing(next);
    if (statusEl.textContent.startsWith("Socket closed")) setStatus("");
  });
  next.addEventListener("message", (ev) => {
    if (typeof ev.data !== "string") return;
    if (ev.data === "pong") return;
    try {
      const parsed = JSON.parse(ev.data) as ServerEvent;
      if (parsed && typeof parsed === "object" && "type" in parsed) applyEvent(parsed);
    } catch {
      setStatus("The room sent a message this page could not read.");
    }
  });
  next.addEventListener("close", (ev) => {
    stopPing();
    if (socket !== next) return;
    if (!wantSocket || !roomCode) {
      setStatus("The socket closed. Join again if the room is still there.");
      return;
    }
    const delay = Math.min(15_000, 500 * 2 ** reconnectAttempt);
    reconnectAttempt += 1;
    const reason = ev.code === 1008 ? "The socket closed after too many frames." : "The socket closed.";
    setStatus(`${reason} Reconnecting in ${Math.max(1, Math.round(delay / 1000))}s…`);
    window.clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(() => connect(code), delay);
  });
}

async function openRoom(code: string): Promise<void> {
  const view = await call<RoomResponse>(`/api/rooms/${code}`);
  roomCode = view.code;
  const url = new URL(location.href);
  url.searchParams.set("room", view.code);
  history.replaceState(null, "", url);
  renderRoom(view, view.code);
  connect(view.code);
}

async function createRoom(): Promise<void> {
  setStatus("");
  try {
    const view = await call<RoomResponse>("/api/rooms", { method: "POST", body: {} });
    roomCode = view.code;
    const url = new URL(location.href);
    url.searchParams.set("room", view.code);
    history.replaceState(null, "", url);
    renderRoom(view, view.code);
    connect(view.code);
  } catch (err) {
    setStatus(err instanceof Error ? err.message : "Could not open a room.");
  }
}

async function sendMessage(event: Event): Promise<void> {
  event.preventDefault();
  const input = must<HTMLInputElement>("message");
  const text = input.value.trim();
  if (!text || !roomCode) return;
  const ask = must<HTMLInputElement>("ask").checked;
  if (socket && socket.readyState === WebSocket.OPEN) {
    pendingSay = text;
    socket.send(JSON.stringify({ type: "say", text, ask }));
    return;
  }
  try {
    const said = await call<{ room: RoomView }>(`/api/rooms/${roomCode}/say`, {
      method: "POST",
      body: { name: must<HTMLInputElement>("nick").value, text, ask },
    });
    input.value = "";
    pendingSay = "";
    renderRoom(said.room);
  } catch (err) {
    setStatus(err instanceof Error ? err.message : "Could not send.");
  }
}

async function unlock(): Promise<void> {
  if (!roomCode) return;
  setStatus("");
  try {
    const view = await call<RoomResponse>(`/api/rooms/${roomCode}/unlock`, { method: "POST", body: { token: tokenOf(unlockWidgetId) } });
    renderRoom(view, view.code);
  } catch (err) {
    setStatus(err instanceof Error ? err.message : "Could not unlock AI.");
  } finally {
    resetWidget(unlockWidgetId, (value) => {
      unlockReady = value;
    });
    syncFire();
  }
}

async function evict(): Promise<void> {
  if (!roomCode) return;
  setStatus("");
  try {
    const view = await call<RoomResponse>(`/api/rooms/${roomCode}/evict`, { method: "POST", body: {} });
    must<HTMLTextAreaElement>("scratch").value = "";
    renderRoom(view, view.code);
  } catch (err) {
    setStatus(err instanceof Error ? err.message : "Could not simulate eviction.");
  }
}

function scheduleScratch(): void {
  window.clearTimeout(scratchTimer);
  scratchTimer = window.setTimeout(() => {
    if (!roomCode) return;
    const text = must<HTMLTextAreaElement>("scratch").value;
    scratchFromUs = true;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "scratch", text }));
      window.setTimeout(() => {
        scratchFromUs = false;
      }, 400);
      return;
    }
    void call(`/api/rooms/${roomCode}/scratch`, { method: "POST", body: { text } }).catch((err: unknown) => {
      setStatus(err instanceof Error ? err.message : "Could not save the scratch note.");
    });
  }, 180);
}

function bind(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>(".n")) {
    button.addEventListener("click", () => {
      n = Number(button.dataset.n);
      for (const peer of document.querySelectorAll(".n")) peer.classList.toggle("is-on", peer === button);
      must<HTMLElement>("n-label").textContent = n === 4 ? "A few updates" : `${n} updates`;
    });
  }
  fireBtn.addEventListener("click", () => void fire());
  must<HTMLButtonElement>("create").addEventListener("click", () => void createRoom());
  must<HTMLButtonElement>("join").addEventListener("click", () => {
    const code = must<HTMLInputElement>("code").value.trim().toUpperCase();
    void openRoom(code).catch((err: unknown) => setStatus(err instanceof Error ? err.message : "Could not join."));
  });
  must<HTMLFormElement>("composer").addEventListener("submit", (event) => void sendMessage(event));
  must<HTMLButtonElement>("unlock").addEventListener("click", () => void unlock());
  must<HTMLButtonElement>("evict").addEventListener("click", () => void evict());
  must<HTMLButtonElement>("copy").addEventListener("click", async () => {
    if (!roomCode) return;
    const url = new URL(location.href);
    url.searchParams.set("room", roomCode);
    try {
      await navigator.clipboard.writeText(url.toString());
      setStatus("Link copied.");
    } catch {
      setStatus(url.toString());
    }
  });
  must<HTMLTextAreaElement>("scratch").addEventListener("input", scheduleScratch);
}

function turnstileCallbacks(kind: "race" | "unlock"): {
  callback: (token: string) => void;
  "expired-callback": () => void;
  "error-callback": () => void;
} {
  const setReady = (value: boolean) => {
    if (kind === "race") raceReady = value;
    else unlockReady = value;
    syncFire();
  };
  return {
    callback: () => setReady(true),
    "expired-callback": () => setReady(false),
    "error-callback": () => {
      setReady(false);
      setStatus("Turnstile failed to load.");
    },
  };
}

async function mountWidget(hostId: string, action: string, kind: "race" | "unlock"): Promise<string> {
  const api = await waitTurnstile();
  const host = document.getElementById(hostId);
  const note = must<HTMLElement>("ai-note");
  if (!api || !host || !siteKey) {
    note.textContent = "The Turnstile script did not load, so AI runs stay disabled.";
    return "";
  }
  try {
    return api.render(host, {
      sitekey: siteKey,
      action,
      ...turnstileCallbacks(kind),
    });
  } catch (err) {
    note.textContent = "The Turnstile script did not load, so AI runs stay disabled.";
    console.warn(JSON.stringify({ event: "turnstile_render_failed", error: String(err) }));
    return "";
  }
}

async function mountUnlockWidget(): Promise<void> {
  if (unlockWidgetId || !aiReady || !siteKey) return;
  unlockWidgetId = await mountWidget("unlock-widget", TURNSTILE_UNLOCK, "unlock");
}

async function main(): Promise<void> {
  bind();
  if (!tableBody) return;
  const cfg = await call<LabConfig>("/api/config");
  const note = must<HTMLElement>("ai-note");
  siteKey = cfg.siteKey ?? "";
  aiReady = cfg.ai === "ready" && Boolean(cfg.siteKey);
  const existing = new URL(location.href).searchParams.get("room");
  if (existing) {
    must<HTMLInputElement>("code").value = existing;
    try {
      await openRoom(existing);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "That room is gone.");
    }
  }
  if (!aiReady) {
    note.textContent = "AI runs are off until the owner sets a real Turnstile site key and TURNSTILE_SECRET. Chat between people still works.";
    syncFire();
    return;
  }
  note.textContent = `Turnstile gates each race and each AI unlock. Model ${cfg.model}. Bars include a short pad when the model returns in under 300 ms.`;
  raceWidgetId = await mountWidget("turnstile-widget", TURNSTILE_RACE, "race");
  if (roomCode) await mountUnlockWidget();
}

void main().catch((err: unknown) => setStatus(err instanceof Error ? err.message : "The page failed to start."));
