import type { ChatMessage, Presence, RoomSummary, ServerEvent, Session } from "../shared/types";

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
      btn.addEventListener("click", () => openRoom(room.id));
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
  if (msg.sessionId && msg.sessionId === state.session?.id) li.classList.add("is-mine");
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
    if (msg.attachment.contentType.startsWith("image/")) {
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

function renderMessages() {
  const list = $("messages");
  const empty = $("empty");
  empty.hidden = state.messages.length > 0;
  list.replaceChildren(...state.messages.map(messageEl));
  list.scrollTop = list.scrollHeight;
}

function addMessage(msg: ChatMessage) {
  if (state.seen.has(msg.id)) return;
  state.seen.add(msg.id);
  state.messages.push(msg);
  $("messages").append(messageEl(msg));
  $("empty").hidden = true;
  const list = $("messages");
  list.scrollTop = list.scrollHeight;
}

async function loadRooms() {
  const data = await api<{ rooms: RoomSummary[] }>("/rooms");
  state.rooms = data.rooms;
  renderRooms();
}

function connectSocket() {
  state.socket?.close();
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${proto}//${location.host}${API_BASE}/ws/${encodeURIComponent(state.roomId)}`);
  state.socket = socket;
  setStrip(`Opening Durable Object for #${state.roomId}…`);
  socket.addEventListener("open", () => setStrip(`Live in #${state.roomId} — messages fan out from one Durable Object.`, "live"));
  socket.addEventListener("close", () => {
    if (state.socket === socket) setStrip("Socket closed. Rejoin the room to connect again.", "off");
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
      renderPresence();
      renderMessages();
      void loadRooms();
      return;
    }
    if (event.type === "message") {
      addMessage(event.message);
      void loadRooms();
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

async function openRoom(id: string) {
  state.roomId = id;
  field("room-name").value = id;
  renderRooms();
  connectSocket();
}

async function saveName() {
  const displayName = field("display-name").value.trim();
  try {
    const data = await api<{ session: Session }>("/session", { method: "POST", body: { displayName } });
    state.session = data.session;
    field("display-name").value = data.session.displayName;
    setHint("Name saved in KV. Rejoining so the room sees it.", "ok");
    connectSocket();
  } catch (err) {
    setHint(err instanceof Error ? err.message : "Could not save the name.", "error");
  }
}

async function send(event: Event) {
  event.preventDefault();
  const draft = field("draft");
  const text = draft.value.trim();
  const file = state.pendingFile;
  try {
    if (file) {
      const form = new FormData();
      form.set("file", file);
      if (text) form.set("caption", text);
      const data = await api<{ message: ChatMessage }>("/rooms/" + encodeURIComponent(state.roomId) + "/upload", {
        method: "POST",
        form,
      });
      addMessage(data.message);
      state.pendingFile = null;
      $("filechip").hidden = true;
      draft.value = "";
      field("file").value = "";
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
    const data = await api<{ message: ChatMessage }>("/rooms/" + encodeURIComponent(state.roomId) + "/messages", {
      method: "POST",
      body: { body: text },
    });
    addMessage(data.message);
    draft.value = "";
    setHint("Sent over HTTP (socket was down).", "ok");
  } catch (err) {
    setHint(err instanceof Error ? err.message : "Send failed.", "error");
  }
}

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
  const name = field("room-name").value.trim() || "lobby";
  void openRoom(name);
});
$("composer").addEventListener("submit", (ev) => void send(ev));
$("file").addEventListener("change", () => {
  const picked = field("file").files?.[0] ?? null;
  state.pendingFile = picked;
  const chip = $("filechip");
  if (picked) {
    chip.hidden = false;
    chip.textContent = picked.name;
  } else {
    chip.hidden = true;
    chip.textContent = "";
  }
});

const params = new URLSearchParams(location.search);
const initialRoom = params.get("room") || "lobby";
field("room-name").value = initialRoom;

void (async () => {
  try {
    const data = await api<{ session: Session }>("/session");
    state.session = data.session;
    field("display-name").value = data.session.displayName;
  } catch {
    setHint("Could not mint a KV session. You can still try joining.", "error");
  }
  try {
    await loadRooms();
  } catch {
    /* first paint still works after socket hello */
  }
  await openRoom(initialRoom);
})();
