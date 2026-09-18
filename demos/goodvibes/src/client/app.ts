import {
  ROUND_MS,
  sanitizeName,
  slugifyRoom,
  type Player,
  type RoundState,
  type ServerEvent,
} from "../shared/types";
import { ArenaScene } from "./scene";

const NAME_KEY = "goodvibes-name";
const ID_KEY = "goodvibes-id";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function appBase(): string {
  const path = location.pathname;
  const marker = "/demos/goodvibes";
  if (path === marker || path.startsWith(`${marker}/`)) return marker;
  return "";
}

function randomName(): string {
  const a = ["Ember", "Graphite", "Cedar", "Flint", "Moss", "Quartz", "Amber", "Slate"];
  const b = ["Fox", "Kite", "Wren", "Pike", "Fern", "Moth", "Lynx", "Jay"];
  return `${a[Math.floor(Math.random() * a.length)]} ${b[Math.floor(Math.random() * b.length)]}`;
}

function sessionId(): string {
  try {
    const existing = sessionStorage.getItem(ID_KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    sessionStorage.setItem(ID_KEY, id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

function storedName(): string {
  try {
    return sanitizeName(localStorage.getItem(NAME_KEY) || "");
  } catch {
    return "Guest";
  }
}

function rememberName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* ignore */
  }
}

function wsUrl(room: string, name: string, id: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams({ name, id });
  return `${proto}//${location.host}${appBase()}/ws/${encodeURIComponent(room)}?${params}`;
}

let audio: AudioContext | null = null;
function beep(freq: number, ms: number, gain = 0.05, type: OscillatorType = "square"): void {
  try {
    audio ??= new AudioContext();
    const ctx = audio;
    void ctx.resume();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.value = gain;
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + ms / 1000);
    o.stop(ctx.currentTime + ms / 1000);
  } catch {
    /* autoplay */
  }
}

const state = {
  ws: null as WebSocket | null,
  scene: null as ArenaScene | null,
  you: null as Player | null,
  room: "",
  players: new Map<string, Player>(),
  round: null as RoundState | null,
};

function setStatus(text: string, kind: "ok" | "warn" | "idle" = "idle"): void {
  const el = $("status");
  el.textContent = text;
  el.dataset.kind = kind;
}

function sendStart(): void {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type: "start" }));
}

function renderBoard(): void {
  const list = $("presence");
  const count = $("count");
  const scores = state.round?.scores ?? [...state.players.values()].map((p) => ({ id: p.id, name: p.name, color: p.color, score: p.score }));
  count.textContent = String(state.players.size);
  list.replaceChildren();
  for (const p of scores) {
    const li = document.createElement("li");
    if (p.id === state.you?.id) li.classList.add("is-you");
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = p.color;
    const label = document.createElement("span");
    label.textContent = `${p.id === state.you?.id ? `${p.name} (you)` : p.name}`;
    const pts = document.createElement("b");
    pts.textContent = String(p.score);
    li.append(swatch, label, pts);
    list.append(li);
  }
}

function applyRound(round: RoundState, players?: Player[]): void {
  state.round = round;
  if (players) {
    for (const p of players) {
      state.players.set(p.id, p);
      if (p.id === state.you?.id) {
        state.you = p;
        state.scene?.setLocal(p);
      } else {
        state.scene?.upsert(p, round.phase === "playing");
      }
    }
  }
  state.scene?.setOrbs(round.orbs);
  renderBoard();
  const banner = $("banner");
  const title = $("banner-title");
  const sub = $("banner-sub");
  const countEl = $("banner-count");
  const start = $("start") as HTMLButtonElement;
  start.hidden = round.phase === "countdown" || round.phase === "playing";
  start.textContent = round.phase === "over" ? "Play again" : "Start round";

  if (round.phase === "waiting") {
    banner.hidden = false;
    countEl.textContent = "";
    title.textContent = "Ember Rush";
    sub.textContent = "75 seconds. Grab glowing orbs. The gold one is +3. Highest score wins.";
    setStatus(`In ${state.room} · waiting to start`, "idle");
  } else if (round.phase === "countdown") {
    banner.hidden = false;
    const n = Math.max(1, Math.ceil((round.endsAt - Date.now()) / 1000));
    countEl.textContent = String(n);
    title.textContent = "Get ready";
    sub.textContent = "WASD or click the floor. First orb is free points.";
    setStatus("Round starting…", "ok");
    beep(220 + n * 110, 90);
  } else if (round.phase === "playing") {
    banner.hidden = true;
    setStatus("Grab the orbs — Durable Object is keeping score", "ok");
    beep(520, 80, 0.04, "triangle");
    beep(780, 120, 0.04, "triangle");
  } else {
    banner.hidden = false;
    countEl.textContent = "";
    const youWin = round.winner?.id === state.you?.id;
    const top = round.winner;
    if (top) {
      title.textContent = youWin ? "You win" : `${top.name} wins`;
      sub.textContent = `${top.score} ember${top.score === 1 ? "" : "s"}. Stay in the room for a rematch.`;
      if (youWin) {
        beep(392, 90);
        beep(523, 140);
      } else beep(180, 220, 0.05, "sawtooth");
    } else {
      title.textContent = "Tie round";
      sub.textContent = "Nobody pulled ahead. Play again.";
    }
    setStatus("Round over", "ok");
  }
  $("room-chip").textContent = state.room || "lobby";
}

function tickHud(): void {
  const clock = $("clock");
  const round = state.round;
  if (!round || round.phase === "waiting") {
    clock.textContent = "0:75";
    clock.dataset.phase = "wait";
  } else if (round.phase === "countdown") {
    const n = Math.max(0, Math.ceil((round.endsAt - Date.now()) / 1000));
    clock.textContent = String(n || "GO");
    clock.dataset.phase = "cd";
    const countEl = $("banner-count");
    if (countEl && $("banner").hidden === false) countEl.textContent = n ? String(n) : "GO";
  } else if (round.phase === "playing") {
    const left = Math.max(0, round.endsAt - Date.now());
    const s = Math.ceil(left / 1000);
    clock.textContent = `0:${String(s).padStart(2, "0")}`;
    clock.dataset.phase = s <= 10 ? "low" : "play";
  } else {
    clock.textContent = "0:00";
    clock.dataset.phase = "over";
  }
  requestAnimationFrame(tickHud);
}

function applyServer(event: ServerEvent): void {
  if (event.type === "hello") {
    state.you = event.you;
    state.room = event.room;
    state.players.clear();
    for (const p of event.players) state.players.set(p.id, p);
    state.scene?.setLocal(event.you);
    for (const p of event.players) {
      if (p.id !== event.you.id) state.scene?.upsert(p, true);
    }
    applyRound(event.round, event.players);
    if (state.scene && !state.scene.webgl) {
      setStatus(`In ${event.room} · 2D fallback · Ember Rush`, "ok");
    }
    return;
  }
  if (event.type === "join") {
    state.players.set(event.player.id, event.player);
    if (event.player.id !== state.you?.id) state.scene?.upsert(event.player, true);
    renderBoard();
    return;
  }
  if (event.type === "leave") {
    state.players.delete(event.id);
    state.scene?.remove(event.id);
    renderBoard();
    return;
  }
  if (event.type === "move") {
    const cur = state.players.get(event.id);
    if (cur) {
      cur.x = event.x;
      cur.z = event.z;
    }
    if (event.id !== state.you?.id) {
      state.scene?.upsert({
        ...(cur ?? { id: event.id, name: "Guest", color: "#c2410c", x: event.x, z: event.z, score: 0 }),
      });
    }
    return;
  }
  if (event.type === "presence") {
    const keep = new Set(event.players.map((p) => p.id));
    for (const id of [...state.players.keys()]) {
      if (!keep.has(id) && id !== state.you?.id) {
        state.players.delete(id);
        state.scene?.remove(id);
      }
    }
    for (const p of event.players) {
      state.players.set(p.id, p);
      if (p.id !== state.you?.id) state.scene?.upsert(p);
    }
    renderBoard();
    return;
  }
  if (event.type === "round") {
    applyRound(event.round, event.players);
    return;
  }
  if (event.type === "collect") {
    const p = state.players.get(event.playerId);
    if (p) p.score = event.score;
    if (state.you?.id === event.playerId) state.you.score = event.score;
    if (state.round) {
      state.round.orbs = event.orbs;
      state.round.scores = event.scores;
    }
    state.scene?.setOrbs(event.orbs);
    const collector = state.players.get(event.playerId);
    if (collector) state.scene?.burst(collector.x, collector.z, event.kind === "hot" ? "#fbbf24" : "#e2622e");
    if (event.playerId === state.you?.id) beep(event.kind === "hot" ? 880 : 660, event.kind === "hot" ? 140 : 70);
    else beep(330, 40, 0.03);
    renderBoard();
    return;
  }
  if (event.type === "error") setStatus(event.message, "warn");
}

function leave(): void {
  state.ws?.close();
  state.ws = null;
  state.scene?.dispose();
  state.scene = null;
  state.you = null;
  state.round = null;
  state.players.clear();
  $("stage").hidden = true;
  $("lobby").hidden = false;
  setStatus("Left the room.", "idle");
  const url = new URL(location.href);
  url.searchParams.delete("room");
  history.replaceState(null, "", url);
}

function enterStage(room: string): void {
  $("lobby").hidden = true;
  $("stage").hidden = false;
  const canvas = $("view") as HTMLCanvasElement;
  state.scene?.dispose();
  state.scene = new ArenaScene(canvas);
  state.scene.setMover((x, z) => {
    if (state.ws?.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: "move", x, z }));
    }
  });
  connect(room);
}

function connect(room: string): void {
  state.ws?.close();
  const name = sanitizeName(($("name") as HTMLInputElement).value || storedName());
  rememberName(name);
  const id = sessionId();
  const ws = new WebSocket(wsUrl(room, name, id));
  state.ws = ws;
  setStatus("Connecting…", "idle");
  ws.addEventListener("open", () => setStatus("Connected. Waiting for hello…", "ok"));
  ws.addEventListener("message", (ev) => {
    if (typeof ev.data !== "string") return;
    try {
      applyServer(JSON.parse(ev.data) as ServerEvent);
    } catch {
      /* ignore */
    }
  });
  ws.addEventListener("close", () => {
    if (state.ws === ws) setStatus("Disconnected. Rejoin from the lobby.", "warn");
  });
  ws.addEventListener("error", () => setStatus("The socket failed.", "warn"));
}

async function createRoom(): Promise<void> {
  const name = slugifyRoom(($("room") as HTMLInputElement).value);
  setStatus("Creating room…", "idle");
  const res = await fetch(`${appBase()}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const data = (await res.json()) as { room?: { id: string }; error?: { message: string } };
  if (!res.ok) {
    setStatus(data.error?.message || `Create failed (${res.status})`, "warn");
    return;
  }
  joinRoom(data.room?.id || name);
}

function joinRoom(raw?: string): void {
  const room = slugifyRoom(raw || ($("room") as HTMLInputElement).value);
  ($("room") as HTMLInputElement).value = room;
  const url = new URL(location.href);
  url.searchParams.set("room", room);
  history.replaceState(null, "", url);
  enterStage(room);
}

function boot(): void {
  const nameInput = $("name") as HTMLInputElement;
  const roomInput = $("room") as HTMLInputElement;
  const saved = storedName();
  nameInput.value = saved === "Guest" ? randomName() : saved;
  const params = new URLSearchParams(location.search);
  roomInput.value = slugifyRoom(params.get("room") || "arena");

  $("create").addEventListener("click", () => {
    void createRoom();
  });
  $("join").addEventListener("click", () => joinRoom());
  $("leave").addEventListener("click", () => leave());
  $("start").addEventListener("click", () => sendStart());
  $("lobby-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    joinRoom();
  });
  window.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const tag = (ev.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON") return;
    if ($("stage").hidden) return;
    if (state.round?.phase === "waiting" || state.round?.phase === "over") {
      ev.preventDefault();
      sendStart();
    }
  });

  tickHud();
  void ROUND_MS;
  if (params.get("room")) joinRoom(params.get("room") || "arena");
}

boot();
