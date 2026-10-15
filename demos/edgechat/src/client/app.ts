import type { ChatMessage, Presence, RoomSummary, ServerEvent, Session, SessionResponse } from "../shared/types";
import { isInlineImageType, MAX_UPLOAD } from "../shared/types";

const API_BASE = location.pathname.startsWith("/demos/edgechat") ? "/demos/edgechat" : "";

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
  const data = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
  if (!res.ok) throw new ApiFailure(res.status, data?.error?.code ?? "http", data?.error?.message ?? `HTTP ${res.status}`);
  return data as T;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const field = (id: string) => $(id) as HTMLInputElement;

const state = {
  session: null as Session | null,
  rooms: [] as RoomSummary[],
  roomId: "lobby",
  messages: [] as ChatMessage[],
  presence: { count: 0, names: [] } as Presence,
  socket: null as WebSocket | null,
  pendingFile: null as File | null,
  seen: new Set<string>(),
  writesOpen: false,
  turnstileSiteKey: null as string | null,
  turnstileId: null as string | null,
  generation: 0,
  backoff: 1000,
  reconnectTimer: 0,
  pingTimer: 0,
  stickToBottom: true,
};

function fileUrl(id: string): string {
  return `${API_BASE}/api/files/${encodeURIComponent(id)}`;
}

function relTime(ms: number): string {
  const delta = Date.now() - ms;
  const min = Math.round(delta / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h`;
  return new Date(ms).toLocaleString();
}

function setStrip(text: string, stateName: "" | "live" | "off" = "") {
  $("strip-text").textContent = text;
  const strip = $("strip");
  if (stateName) strip.dataset.state = stateName;
  else delete strip.dataset.state;
}

function setHint(message: string, tone: "" | "ok" | "error" = "") {
  const el = $("hint");
  el.textContent = message;
  if (tone) el.dataset.tone = tone;
  else delete el.dataset.tone;
}

function setRoomUrl(id: string) {
  const next = `?room=${encodeURIComponent(id)}`;
  if (`${location.search}` !== next) history.replaceState(null, "", next);
}

function upsertRoom(room: RoomSummary) {
  const idx = state.rooms.findIndex((r) => r.id === room.id);
  if (idx >= 0) state.rooms[idx] = room;
  else state.rooms.unshift(room);
  state.rooms.sort((a, b) => {
    if (a.id === "lobby") return -1;
    if (b.id === "lobby") return 1;
    return b.lastMessageAt - a.lastMessageAt;
  });
  renderRooms();
}

function renderRooms() {
  $("room-count").textContent = String(state.rooms.length);
  const list = $("room-list");
  list.replaceChildren(
    ...state.rooms.map((room) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "room-btn";
      if (room.id === state.roomId) btn.classList.add("is-on");
      const name = document.createElement("span");
      name.className = "room-btn__name";
      name.textContent = room.name;
      const preview = document.createElement("span");
      preview.className = "room-btn__preview";
      preview.textContent = room.lastPreview || `${room.messageCount} messages`;
      btn.append(name, preview);
      btn.addEventListener("click", () => void openRoom(room.id));
      li.append(btn);
      return li;
    }),
  );
}

function renderPresence() {
  const extra = state.presence.names.slice(0, 4).join(", ");
  $("presence").textContent =
    state.presence.count === 1 ? `1 in room${extra ? ` · ${extra}` : ""}` : `${state.presence.count} in room${extra ? ` · ${extra}` : ""}`;
}

function messageEl(msg: ChatMessage): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "msg";
  li.dataset.id = msg.id;
  if (msg.authorKey && msg.authorKey === state.session?.publicId) li.classList.add("is-mine");
  const meta = document.createElement("div");
  meta.className = "msg__meta";
  const author = document.createElement("span");
  author.className = "msg__author";
  author.textContent = msg.author;
  const time = document.createElement("time");
  time.className = "msg__time";
  time.dateTime = new Date(msg.createdAt).toISOString();
  time.textContent = relTime(msg.createdAt);
  meta.append(author, time);
  const body = document.createElement("p");
  body.className = "msg__body";
  body.textContent = msg.body;
  li.append(meta, body);
  if (msg.attachment) {
    if (isInlineImageType(msg.attachment.contentType)) {
      const img = document.createElement("img");
      img.className = "msg__img";
      img.alt = msg.attachment.filename;
      img.src = fileUrl(msg.attachment.id);
      li.append(img);
    }
    const link = document.createElement("a");
    link.className = "msg__file";
    link.href = fileUrl(msg.attachment.id);
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = `File · ${msg.attachment.filename}`;
    li.append(link);
  }
  return li;
}

function listNearBottom(): boolean {
  const list = $("messages");
  return list.scrollHeight - list.scrollTop - list.clientHeight < 80;
}

function scrollMessages(force = false) {
  const list = $("messages");
  if (force || state.stickToBottom) list.scrollTop = list.scrollHeight;
}

function renderMessages() {
  const list = $("messages");
  const empty = $("empty");
  empty.hidden = state.messages.length > 0;
  list.replaceChildren(...state.messages.map(messageEl));
  scrollMessages(true);
}

function addMessage(msg: ChatMessage) {
  if (state.seen.has(msg.id)) return;
  state.seen.add(msg.id);
  state.messages.push(msg);
  $("messages").append(messageEl(msg));
  $("empty").hidden = true;
  scrollMessages();
}

async function loadRooms() {
  const data = await api<{ rooms: RoomSummary[] }>("/rooms");
  state.rooms = data.rooms;
  renderRooms();
}

function clearReconnect() {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = 0;
  }
}

function scheduleReconnect() {
  clearReconnect();
  if (document.visibilityState === "hidden") return;
  if (!state.session?.persisted) return;
  const wait = state.backoff;
  state.backoff = Math.min(state.backoff * 2, 30_000);
  state.reconnectTimer = window.setTimeout(() => connectSocket(), wait);
}

function connectSocket() {
  if (!state.session?.persisted) {
    setStrip("Solve the check to join a live room.", "off");
    return;
  }
  clearReconnect();
  if (state.pingTimer) {
    clearInterval(state.pingTimer);
    state.pingTimer = 0;
  }
  const previous = state.socket;
  state.socket = null;
  previous?.close();
  const gen = ++state.generation;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${proto}//${location.host}${API_BASE}/ws/${encodeURIComponent(state.roomId)}`);
  state.socket = socket;
  setStrip(`Opening Durable Object for #${state.roomId}…`);
  socket.addEventListener("open", () => {
    if (state.generation !== gen) return;
    state.backoff = 1000;
    setStrip(`Live in #${state.roomId} — the room sleeps between messages while you stay connected.`, "live");
    state.pingTimer = window.setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
    }, 30_000);
  });
  socket.addEventListener("close", () => {
    if (state.generation !== gen) return;
    if (state.socket === socket) state.socket = null;
    setStrip("Socket closed. Reconnecting…", "off");
    scheduleReconnect();
  });
  socket.addEventListener("error", () => {
    if (state.generation !== gen) return;
    setStrip("Socket error. Reconnecting…", "off");
  });
  socket.addEventListener("message", (ev) => {
    if (typeof ev.data !== "string") return;
    let event: ServerEvent | { type: "pong" };
    try {
      event = JSON.parse(ev.data) as ServerEvent | { type: "pong" };
    } catch {
      return;
    }
    if (event.type === "pong") return;
    if (event.type === "hello") {
      state.session = event.you;
      field("display-name").value = event.you.displayName;
      state.roomId = event.room.id;
      $("room-title").textContent = event.room.name;
      $("room-label").textContent = "room";
      state.presence = event.presence;
      state.messages = event.messages;
      state.seen = new Set(event.messages.map((m) => m.id));
      setRoomUrl(event.room.id);
      upsertRoom(event.room);
      renderPresence();
      renderMessages();
      return;
    }
    if (event.type === "message") {
      addMessage(event.message);
      upsertRoom(event.room);
      return;
    }
    if (event.type === "presence") {
      state.presence = event.presence;
      renderPresence();
      return;
    }
    if (event.type === "error") setHint(event.message, "error");
  });
}

async function openRoom(raw: string) {
  const name = raw.trim() || "lobby";
  field("room-name").value = name;
  if (!state.session?.persisted) {
    state.roomId = name;
    setRoomUrl(name);
    renderRooms();
    setHint("Complete the check to create or join a live room.", "error");
    return;
  }
  try {
    const data = await api<{ room: RoomSummary }>("/rooms", { method: "POST", body: { name } });
    state.roomId = data.room.id;
    $("room-title").textContent = data.room.name;
    setRoomUrl(data.room.id);
    upsertRoom(data.room);
    renderRooms();
    connectSocket();
  } catch (err) {
    setHint(err instanceof Error ? err.message : "Could not open the room.", "error");
  }
}

type TurnstileApi = {
  render: (el: HTMLElement, opts: { sitekey: string; callback: (token: string) => void; "error-callback": () => void }) => string;
  reset: (id?: string) => void;
};

function turnstileApi(): TurnstileApi | undefined {
  const apiObj = (window as Window & { turnstile?: Partial<TurnstileApi> }).turnstile;
  if (!apiObj?.render || !apiObj.reset) return undefined;
  return apiObj as TurnstileApi;
}

async function mountTurnstile(siteKey: string): Promise<void> {
  const ready = (window as Window & { __turnstileReady?: Promise<void> }).__turnstileReady;
  if (ready) await Promise.race([ready, new Promise((resolve) => setTimeout(resolve, 8000))]);
  const widget = turnstileApi();
  const host = $("turnstile");
  host.hidden = false;
  if (!widget) {
    setHint("The check could not load. Refresh and try again.", "error");
    return;
  }
  if (state.turnstileId) widget.reset(state.turnstileId);
  state.turnstileId = widget.render(host, {
    sitekey: siteKey,
    callback: (token) => void mintSession(token),
    "error-callback": () => setHint("The check failed. Refresh and try again.", "error"),
  });
}

async function mintSession(turnstileToken: string, displayName?: string): Promise<void> {
  const data = await api<SessionResponse>("/session", {
    method: "POST",
    body: { displayName: displayName ?? field("display-name").value.trim(), turnstileToken },
  });
  applySession(data);
  $("turnstile").hidden = true;
  setHint("Session saved in KV. Joining the room.", "ok");
  await openRoom(state.roomId || field("room-name").value || "lobby");
}

function applySession(data: SessionResponse) {
  state.session = data.session;
  state.writesOpen = data.writesOpen;
  state.turnstileSiteKey = data.turnstileSiteKey;
  field("display-name").value = data.session.displayName;
}

async function saveName() {
  const displayName = field("display-name").value.trim();
  if (!state.session?.persisted) {
    setHint("Complete the check first.", "error");
    return;
  }
  try {
    const data = await api<SessionResponse>("/session", { method: "POST", body: { displayName } });
    applySession(data);
    setHint("Name saved in KV. Rejoining so the room sees it.", "ok");
    connectSocket();
  } catch (err) {
    setHint(err instanceof Error ? err.message : "Could not save the name.", "error");
  }
}

function clearFile() {
  state.pendingFile = null;
  $("filechip").hidden = true;
  $("filechip").textContent = "";
  field("file").value = "";
}

async function send(event: Event) {
  event.preventDefault();
  const draft = field("draft");
  const text = draft.value.trim();
  const file = state.pendingFile;
  try {
    if (file) {
      if (file.size > MAX_UPLOAD) {
        setHint("Files must be 1 MB or smaller.", "error");
        return;
      }
      const form = new FormData();
      form.set("file", file);
      if (text) form.set("caption", text);
      const data = await api<{ message: ChatMessage; room: RoomSummary }>("/rooms/" + encodeURIComponent(state.roomId) + "/upload", {
        method: "POST",
        form,
      });
      addMessage(data.message);
      upsertRoom(data.room);
      clearFile();
      draft.value = "";
      setHint("Uploaded to R2 and posted in the room.", "ok");
      return;
    }
    if (!text) {
      setHint("Type a message, or attach a file.", "error");
      return;
    }
    if (state.socket?.readyState === WebSocket.OPEN) {
      state.socket.send(JSON.stringify({ type: "send", body: text }));
      draft.value = "";
      setHint("");
      return;
    }
    const data = await api<{ message: ChatMessage; room: RoomSummary }>("/rooms/" + encodeURIComponent(state.roomId) + "/messages", {
      method: "POST",
      body: { body: text },
    });
    addMessage(data.message);
    upsertRoom(data.room);
    draft.value = "";
    setHint("Sent over HTTP (socket was down).", "ok");
  } catch (err) {
    setHint(err instanceof Error ? err.message : "Send failed.", "error");
  }
}

$("messages").addEventListener("scroll", () => {
  state.stickToBottom = listNearBottom();
});

$("theme").addEventListener("click", () => {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try {
    localStorage.setItem("theme", next);
  } catch {
    /* private mode */
  }
});

$("save-name").addEventListener("click", () => void saveName());
$("display-name").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    void saveName();
  }
});
$("join").addEventListener("submit", (ev) => {
  ev.preventDefault();
  void openRoom(field("room-name").value.trim() || "lobby");
});
$("composer").addEventListener("submit", (ev) => void send(ev));
$("file").addEventListener("change", () => {
  const picked = field("file").files?.[0] ?? null;
  if (picked && picked.size > MAX_UPLOAD) {
    setHint("Files must be 1 MB or smaller.", "error");
    clearFile();
    return;
  }
  state.pendingFile = picked;
  const chip = $("filechip");
  if (picked) {
    chip.hidden = false;
    chip.textContent = `${picked.name} · clear`;
  } else {
    chip.hidden = true;
    chip.textContent = "";
  }
});
$("filechip").addEventListener("click", () => clearFile());

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    state.backoff = 1000;
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) connectSocket();
  }
});
window.addEventListener("online", () => {
  state.backoff = 1000;
  connectSocket();
});

const params = new URLSearchParams(location.search);
const initialRoom = params.get("room") || "lobby";
field("room-name").value = initialRoom;
state.roomId = initialRoom;

void (async () => {
  try {
    const data = await api<SessionResponse>("/session");
    applySession(data);
    if (!data.session.persisted) {
      if (!data.writesOpen || !data.turnstileSiteKey) {
        setHint("Writes are off until the owner sets a Turnstile widget. History is still readable.", "error");
      } else {
        setHint("Complete the check to send and join live rooms.");
        await mountTurnstile(data.turnstileSiteKey);
      }
    }
  } catch {
    setHint("Could not read the session. You can still read the lobby.", "error");
  }
  try {
    await loadRooms();
  } catch {
    /* first paint still works after socket hello */
  }
  if (state.session?.persisted) await openRoom(initialRoom);
  else {
    try {
      const data = await api<{ room: RoomSummary; messages: ChatMessage[] }>(`/rooms/${encodeURIComponent(initialRoom)}`);
      state.roomId = data.room.id;
      $("room-title").textContent = data.room.name;
      state.messages = data.messages;
      state.seen = new Set(data.messages.map((m) => m.id));
      upsertRoom(data.room);
      renderMessages();
    } catch {
      /* lobby may be the only readable room */
    }
  }
})();
