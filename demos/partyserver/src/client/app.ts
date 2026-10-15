import YProvider from "y-partyserver/provider";
import * as Y from "yjs";
import {
  BASE_PATH,
  BOARD_HEIGHT,
  BOARD_WIDTH,
  CLOSE_EXPIRED,
  CLOSE_FRAME,
  CLOSE_FULL,
  CLOSE_RATE,
  CLOSE_UNKNOWN,
  INK,
  MAX_STROKES,
  PARTY,
  ROOM_ALPHABET,
  ROOM_ID,
  STROKE_SIZES,
  cleanName,
  isInk,
  parseStroke,
  type PublicConfig,
  type RoomStatus,
  type Stroke,
} from "../shared/protocol";

type TurnstileApi = {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      action?: string;
      theme?: "dark" | "light";
      callback?: (token: string) => void;
      "error-callback"?: () => void;
      "expired-callback"?: () => void;
    },
  ) => string;
  reset: (id?: string) => void;
  getResponse: (id?: string) => string | undefined;
};

type Presence = { name: string; color: string; x: number; y: number; on: boolean };

type BoardLayout = { ox: number; oy: number; scale: number; drawW: number; drawH: number };

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}

function api(path: string): string {
  const base = location.pathname.startsWith(BASE_PATH) ? BASE_PATH : "";
  return `${base}${path}`;
}

function randomId(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let id = "";
  for (const byte of bytes) id += ROOM_ALPHABET[byte % ROOM_ALPHABET.length]!;
  return id;
}

function clientKey(): string {
  const existing = localStorage.getItem("partyserver.client");
  if (existing && /^[a-z0-9]{8}$/.test(existing)) return existing;
  const id = randomId(8);
  localStorage.setItem("partyserver.client", id);
  return id;
}

function storedName(): string {
  return cleanName(localStorage.getItem("partyserver.name") ?? "");
}

function storedColor(): string {
  const value = localStorage.getItem("partyserver.color") ?? INK[0];
  return isInk(value) ? value : INK[0];
}

function turnstileApi(): TurnstileApi | null {
  const host = window as Window & { turnstile?: TurnstileApi };
  return host.turnstile ?? null;
}

function hint(node: HTMLElement, text: string, tone?: "error" | "ok"): void {
  node.textContent = text;
  if (tone) node.dataset.tone = tone;
  else delete node.dataset.tone;
}

function layoutOf(width: number, height: number): BoardLayout {
  const scale = Math.min(width / BOARD_WIDTH, height / BOARD_HEIGHT);
  const drawW = BOARD_WIDTH * scale;
  const drawH = BOARD_HEIGHT * scale;
  return { ox: (width - drawW) / 2, oy: (height - drawH) / 2, scale, drawW, drawH };
}

document.getElementById("theme")?.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("theme", next);
});

const roomId = new URLSearchParams(location.search).get("room");

if (roomId && ROOM_ID.test(roomId)) void joinRoom(roomId);
else void showGate(roomId);

async function showGate(invalidRoom: string | null): Promise<void> {
  const nameInput = byId<HTMLInputElement>("name");
  const open = byId<HTMLButtonElement>("open-room");
  const gateHint = byId<HTMLParagraphElement>("gate-hint");
  nameInput.value = storedName() === "Guest" ? "" : storedName();
  if (invalidRoom) hint(gateHint, "That room link is not valid. Open a new one.", "error");

  let config: PublicConfig;
  try {
    const res = await fetch(api("/api/config"));
    config = (await res.json()) as PublicConfig;
  } catch {
    hint(gateHint, "The board could not be reached.", "error");
    return;
  }
  if (!config.createOpen || !config.siteKey) {
    hint(gateHint, "Room creation is off until Turnstile is configured for this host.", "error");
    return;
  }

  const widget = await renderTurnstile(config.siteKey, () => {
    open.disabled = false;
    hint(gateHint, "Check passed. Open a room when you are ready.", "ok");
  });
  if (!widget) {
    hint(gateHint, "Turnstile did not load. Refresh and try again.", "error");
    return;
  }
  open.addEventListener("click", () => {
    void createRoom(widget);
  });
}

function renderTurnstile(siteKey: string, onToken: () => void): Promise<TurnstileApi | null> {
  const slot = byId<HTMLDivElement>("turnstile");
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = window.setInterval(() => {
      const apiRef = turnstileApi();
      if (apiRef) {
        window.clearInterval(timer);
        apiRef.render(slot, {
          sitekey: siteKey,
          action: "create-room",
          theme: document.documentElement.dataset.theme === "light" ? "light" : "dark",
          callback: () => onToken(),
          "error-callback": () => hint(byId("gate-hint"), "Turnstile could not check this browser.", "error"),
        });
        resolve(apiRef);
        return;
      }
      if (Date.now() - started > 8000) {
        window.clearInterval(timer);
        resolve(null);
      }
    }, 50);
  });
}

async function createRoom(widget: TurnstileApi): Promise<void> {
  const open = byId<HTMLButtonElement>("open-room");
  const gateHint = byId<HTMLParagraphElement>("gate-hint");
  const name = cleanName(byId<HTMLInputElement>("name").value);
  localStorage.setItem("partyserver.name", name);
  const token = widget.getResponse() ?? "";
  if (!token) {
    hint(gateHint, "Finish the Turnstile check first.", "error");
    return;
  }
  open.disabled = true;
  try {
    const res = await fetch(api("/api/rooms"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnstileToken: token }),
    });
    const body = (await res.json()) as { id?: string; error?: { message: string } };
    if (!res.ok || !body.id) {
      hint(gateHint, body.error?.message ?? "The room was not created.", "error");
      widget.reset();
      open.disabled = false;
      return;
    }
    const next = new URL(location.href);
    next.search = `?room=${body.id}`;
    location.assign(next.toString());
  } catch {
    hint(gateHint, "The room was not created.", "error");
    widget.reset();
    open.disabled = false;
  }
}

async function joinRoom(id: string): Promise<void> {
  byId<HTMLElement>("gate").hidden = true;
  const workspace = byId<HTMLElement>("workspace");
  workspace.hidden = false;
  byId<HTMLElement>("room-label").textContent = id;

  let status: RoomStatus;
  try {
    const statusRes = await fetch(api(`/api/rooms/${id}`));
    if (!statusRes.ok) {
      setStatus("error", "This room is gone. Open a new one.");
      return;
    }
    status = (await statusRes.json()) as RoomStatus;
  } catch {
    setStatus("error", "The board could not be reached.");
    return;
  }
  paintExpiry(status.expiresAt);
  window.setInterval(() => paintExpiry(status.expiresAt), 30_000);
  if (status.full) showBoardHint("This board is full. Erase something or open a new room.", "error");

  const nameInput = byId<HTMLInputElement>("board-name");
  nameInput.value = storedName() === "Guest" ? "" : storedName();
  let color = storedColor();
  let size: (typeof STROKE_SIZES)[number] = 6;
  let tool: "pen" | "erase" = "pen";
  const mine: string[] = [];
  const me = clientKey();

  const doc = new Y.Doc();
  const strokes = doc.getMap<string>("strokes");
  const base = location.pathname.startsWith(BASE_PATH) ? BASE_PATH : "";
  const provider = new YProvider(`${location.host}${base}`, id, doc, {
    party: PARTY,
    disableBc: true,
  });

  let fatal = false;
  provider.on("connection-close", (event: CloseEvent) => {
    const isFatal = [CLOSE_EXPIRED, CLOSE_FULL, CLOSE_UNKNOWN, CLOSE_RATE, CLOSE_FRAME].includes(event.code);
    if (!isFatal) return;
    fatal = true;
    provider.shouldConnect = false;
    const text =
      event.code === CLOSE_FULL
        ? "This room is full."
        : event.code === CLOSE_EXPIRED
          ? "This room has expired."
          : event.code === CLOSE_RATE || event.code === CLOSE_FRAME
            ? "This connection was closed for sending too much."
            : "This room does not exist.";
    setStatus("error", text);
    lockBoard();
  });

  const presence = (): Presence => ({
    name: cleanName(nameInput.value),
    color,
    x: 0,
    y: 0,
    on: false,
  });
  let cursor = presence();
  provider.awareness.setLocalState(cursor);

  provider.on("status", (next: { status: string }) => {
    if (fatal) return;
    if (next.status === "connected") setStatus("connected", "Live on the Durable Object");
    else if (next.status === "connecting") setStatus("", "Connecting…");
    else setStatus("", "Reconnecting…");
  });
  provider.on("custom-message", (message: string) => {
    try {
      const parsed = JSON.parse(message) as { type?: string };
      if (parsed.type === "cap") showBoardHint("This board is full. Erase something or open a new room.", "error");
      if (parsed.type === "open") hint(byId("board-hint"), "");
    } catch {
      /* ignore non-json control frames */
    }
  });

  const canvas = byId<HTMLCanvasElement>("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const hintNode = byId<HTMLParagraphElement>("canvas-hint");
  let draft: number[] | null = null;
  let lastCursor = 0;

  const paint = () => {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.floor(rect.width * dpr));
    const height = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const layout = layoutOf(rect.width, rect.height);
    const styles = getComputedStyle(document.documentElement);
    ctx.fillStyle = styles.getPropertyValue("--surface-2").trim() || "#1b1b20";
    ctx.fillRect(0, 0, rect.width, rect.height);
    ctx.fillStyle = styles.getPropertyValue("--paper").trim() || "#141418";
    ctx.fillRect(layout.ox, layout.oy, layout.drawW, layout.drawH);
    const grid = styles.getPropertyValue("--grid").trim() || "rgba(255,255,255,0.045)";
    ctx.fillStyle = grid;
    const step = 22;
    for (let x = layout.ox; x < layout.ox + layout.drawW; x += step) {
      for (let y = layout.oy; y < layout.oy + layout.drawH; y += step) {
        ctx.fillRect(x, y, 1, 1);
      }
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(layout.ox, layout.oy, layout.drawW, layout.drawH);
    ctx.clip();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    let count = 0;
    strokes.forEach((raw) => {
      const stroke = parseStroke(raw);
      if (!stroke) return;
      count += 1;
      drawStroke(ctx, stroke, layout);
    });
    if (draft && draft.length >= 2) {
      drawStroke(ctx, { id: "draft", color, size, points: draft, client: me }, layout);
    }
    hintNode.hidden = fatal || count > 0 || draft !== null;
    const states = provider.awareness.getStates();
    states.forEach((raw, clientId) => {
      if (clientId === doc.clientID) return;
      if (!isPresence(raw) || !raw.on) return;
      drawCursor(ctx, raw, layout);
    });
    ctx.restore();
    paintPeople(provider, doc.clientID);
  };

  const schedule = () => requestAnimationFrame(paint);
  strokes.observe(schedule);
  provider.awareness.on("change", schedule);
  new ResizeObserver(schedule).observe(canvas);

  const pointOf = (event: PointerEvent): [number, number] | null => {
    const rect = canvas.getBoundingClientRect();
    const layout = layoutOf(rect.width, rect.height);
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    if (px < layout.ox || py < layout.oy || px > layout.ox + layout.drawW || py > layout.oy + layout.drawH) return null;
    const x = Math.round(Math.min(BOARD_WIDTH, Math.max(0, (px - layout.ox) / layout.scale)));
    const y = Math.round(Math.min(BOARD_HEIGHT, Math.max(0, (py - layout.oy) / layout.scale)));
    return [x, y];
  };

  canvas.addEventListener("pointerdown", (event) => {
    if (fatal) return;
    const at = pointOf(event);
    if (!at) return;
    if (strokes.size >= MAX_STROKES && tool === "pen") {
      showBoardHint("This board is full. Erase something or open a new room.", "error");
      return;
    }
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    const [x, y] = at;
    if (tool === "erase") {
      eraseAt(strokes, x, y);
      return;
    }
    draft = [x, y];
    schedule();
  });
  canvas.addEventListener("pointermove", (event) => {
    if (fatal) return;
    const at = pointOf(event);
    if (!at) return;
    const [x, y] = at;
    const now = Date.now();
    if (now - lastCursor > 40) {
      lastCursor = now;
      cursor = {
        ...cursor,
        x: x / BOARD_WIDTH,
        y: y / BOARD_HEIGHT,
        on: true,
        name: cleanName(nameInput.value),
        color,
      };
      provider.awareness.setLocalState(cursor);
    }
    if (!draft) return;
    const px = draft[draft.length - 2] ?? x;
    const py = draft[draft.length - 1] ?? y;
    if (Math.hypot(x - px, y - py) < 40) return;
    draft.push(x, y);
    if (draft.length >= 500) {
      commitStroke(strokes, { id: randomId(8), color, size, points: draft.slice(), client: me }, mine);
      draft = [x, y];
    }
    schedule();
  });
  const finish = (event: PointerEvent) => {
    if (fatal || !draft) return;
    const at = pointOf(event);
    if (at) draft.push(at[0], at[1]);
    commitStroke(strokes, { id: randomId(8), color, size, points: draft.slice(0, 600), client: me }, mine);
    draft = null;
    schedule();
  };
  canvas.addEventListener("pointerup", finish);
  canvas.addEventListener("pointercancel", () => {
    draft = null;
    schedule();
  });
  canvas.addEventListener("pointerleave", () => {
    cursor = { ...cursor, on: false };
    provider.awareness.setLocalState(cursor);
    schedule();
  });

  nameInput.addEventListener("change", () => {
    const name = cleanName(nameInput.value);
    localStorage.setItem("partyserver.name", name);
    cursor = { ...cursor, name };
    provider.awareness.setLocalState(cursor);
  });

  const swatches = byId<HTMLDivElement>("swatches");
  for (const ink of INK) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "swatch";
    button.style.background = ink;
    button.setAttribute("aria-label", ink);
    if (ink === color) button.classList.add("is-on");
    button.addEventListener("click", () => {
      if (fatal) return;
      color = ink;
      localStorage.setItem("partyserver.color", ink);
      cursor = { ...cursor, color };
      provider.awareness.setLocalState(cursor);
      for (const peer of swatches.querySelectorAll(".swatch")) peer.classList.remove("is-on");
      button.classList.add("is-on");
    });
    swatches.append(button);
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>(".size")) {
    button.addEventListener("click", () => {
      if (fatal) return;
      const next = Number(button.dataset.size);
      if (!STROKE_SIZES.includes(next as (typeof STROKE_SIZES)[number])) return;
      size = next as (typeof STROKE_SIZES)[number];
      for (const peer of document.querySelectorAll(".size")) peer.classList.remove("is-on");
      button.classList.add("is-on");
    });
  }
  byId("tool-pen").addEventListener("click", () => {
    if (fatal) return;
    tool = "pen";
    byId("tool-pen").classList.add("is-on");
    byId("tool-erase").classList.remove("is-on");
    canvas.style.cursor = "crosshair";
  });
  byId("tool-erase").addEventListener("click", () => {
    if (fatal) return;
    tool = "erase";
    byId("tool-erase").classList.add("is-on");
    byId("tool-pen").classList.remove("is-on");
    canvas.style.cursor = "cell";
  });
  byId("undo").addEventListener("click", () => {
    if (fatal) return;
    const id = mine.pop();
    if (id) strokes.delete(id);
    schedule();
  });
  byId("copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      showBoardHint("Link copied.", "ok");
    } catch {
      showBoardHint(location.href, "ok");
    }
  });

  if (fatal) lockBoard();
  schedule();
}

function commitStroke(strokes: Y.Map<string>, stroke: Stroke, mine: string[]): void {
  if (strokes.size >= MAX_STROKES) {
    showBoardHint("This board is full. Erase something or open a new room.", "error");
    return;
  }
  strokes.set(stroke.id, JSON.stringify(stroke));
  mine.push(stroke.id);
}

function eraseAt(strokes: Y.Map<string>, x: number, y: number): void {
  const victims: string[] = [];
  strokes.forEach((raw, key) => {
    const stroke = parseStroke(raw);
    if (!stroke) return;
    for (let i = 0; i < stroke.points.length; i += 2) {
      const dx = (stroke.points[i] ?? 0) - x;
      const dy = (stroke.points[i + 1] ?? 0) - y;
      if (dx * dx + dy * dy < 90_000) {
        victims.push(key);
        return;
      }
    }
  });
  for (const key of victims) strokes.delete(key);
}

function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke, layout: BoardLayout): void {
  const pts = stroke.points;
  const xAt = (i: number) => layout.ox + ((pts[i] ?? 0) * layout.scale);
  const yAt = (i: number) => layout.oy + ((pts[i + 1] ?? 0) * layout.scale);
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineWidth = stroke.size;
  if (pts.length < 4) {
    ctx.beginPath();
    ctx.arc(xAt(0), yAt(0), stroke.size / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(xAt(0), yAt(0));
  for (let i = 2; i < pts.length - 2; i += 2) {
    const x1 = xAt(i);
    const y1 = yAt(i);
    const x2 = xAt(i + 2);
    const y2 = yAt(i + 2);
    ctx.quadraticCurveTo(x1, y1, (x1 + x2) / 2, (y1 + y2) / 2);
  }
  ctx.lineTo(xAt(pts.length - 2), yAt(pts.length - 2));
  ctx.stroke();
}

function drawCursor(ctx: CanvasRenderingContext2D, presence: Presence, layout: BoardLayout): void {
  const x = layout.ox + presence.x * BOARD_WIDTH * layout.scale;
  const y = layout.oy + presence.y * BOARD_HEIGHT * layout.scale;
  ctx.save();
  ctx.fillStyle = presence.color;
  ctx.strokeStyle = presence.color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, 5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.font = "600 12px Hanken Grotesk, sans-serif";
  ctx.fillText(cleanName(presence.name), x + 10, y - 8);
  ctx.restore();
}

function paintPeople(provider: YProvider, selfId: number): void {
  const list = byId<HTMLUListElement>("people");
  list.replaceChildren();
  provider.awareness.getStates().forEach((raw, clientId) => {
    if (!isPresence(raw)) return;
    const item = document.createElement("li");
    const dot = document.createElement("span");
    dot.className = "person-dot";
    dot.style.background = raw.color;
    const label = document.createElement("span");
    label.textContent = clientId === selfId ? `${cleanName(raw.name)} (you)` : cleanName(raw.name);
    item.append(dot, label);
    list.append(item);
  });
}

function isPresence(value: unknown): value is Presence {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.name === "string" &&
    typeof rec.color === "string" &&
    isInk(rec.color) &&
    typeof rec.x === "number" &&
    typeof rec.y === "number" &&
    typeof rec.on === "boolean"
  );
}

function setStatus(state: string, text: string): void {
  const dot = byId<HTMLElement>("dot");
  if (state) dot.dataset.state = state;
  else delete dot.dataset.state;
  byId("status-text").textContent = text;
}

function showBoardHint(text: string, tone: "error" | "ok"): void {
  hint(byId("board-hint"), text, tone);
}

function lockBoard(): void {
  const workspace = byId<HTMLElement>("workspace");
  workspace.classList.add("is-fatal");
  const canvas = byId<HTMLCanvasElement>("canvas");
  canvas.style.pointerEvents = "none";
  canvas.style.cursor = "default";
  byId("canvas-hint").hidden = true;
  for (const id of ["tool-pen", "tool-erase", "undo"]) {
    (byId<HTMLButtonElement>(id) as HTMLButtonElement).disabled = true;
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>(".swatch, .size")) button.disabled = true;
}

function paintExpiry(expiresAt: number): void {
  const left = Math.max(0, expiresAt - Date.now());
  const minutes = Math.floor(left / 60_000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  byId("expiry").textContent = left === 0 ? "Expired" : hours > 0 ? `Expires in ${hours}h ${rest}m` : `Expires in ${rest}m`;
}
