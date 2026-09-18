import { sanitizeName, slugifyRoom, type Player, type ServerEvent } from "../shared/types";
import { LobbyScene } from "./scene";

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

const state = {
  ws: null as WebSocket | null,
  scene: null as LobbyScene | null,
  you: null as Player | null,
  room: "",
  players: new Map<string, Player>(),
};

function setStatus(text: string, kind: "ok" | "warn" | "idle" = "idle"): void {
  const el = $("status");
  el.textContent = text;
  el.dataset.kind = kind;
}

function renderPresence(): void {
  const list = $("presence");
  const count = $("count");
  const players = [...state.players.values()];
  count.textContent = String(players.length);
  list.replaceChildren();
  for (const p of players) {
    const li = document.createElement("li");
    if (p.id === state.you?.id) li.classList.add("is-you");
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = p.color;
    const label = document.createElement("span");
    label.textContent = p.id === state.you?.id ? `${p.name} (you)` : p.name;
    li.append(swatch, label);
    list.append(li);
  }
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
    renderPresence();
    setStatus(`In ${event.room} · live over a Durable Object`, "ok");
    $("room-chip").textContent = event.room;
    if (state.scene && !state.scene.webgl) {
      setStatus(`In ${event.room} · 2D fallback (WebGL unavailable)`, "ok");
    }
    return;
  }
  if (event.type === "join") {
    state.players.set(event.player.id, event.player);
    if (event.player.id !== state.you?.id) state.scene?.upsert(event.player, true);
    renderPresence();
    return;
  }
  if (event.type === "leave") {
    state.players.delete(event.id);
    state.scene?.remove(event.id);
    renderPresence();
    return;
  }
  if (event.type === "move") {
    const cur = state.players.get(event.id);
    if (cur) {
      cur.x = event.x;
      cur.z = event.z;
    }
    if (event.id !== state.you?.id) state.scene?.upsert({ ...(cur ?? { id: event.id, name: "Guest", color: "#c2410c", x: event.x, z: event.z }) });
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
    renderPresence();
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
  state.scene = new LobbyScene(canvas);
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
  const id = data.room?.id || name;
  joinRoom(id);
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
  roomInput.value = slugifyRoom(params.get("room") || "lobby");

  $("create").addEventListener("click", () => {
    void createRoom();
  });
  $("join").addEventListener("click", () => joinRoom());
  $("leave").addEventListener("click", () => leave());
  $("lobby-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    joinRoom();
  });

  if (params.get("room")) joinRoom(params.get("room") || "lobby");
}

boot();
