import { admitFrame, admitSay, admitScratch, clipSpeakerName, isReservedName, livePeers, ROOM_EXPIRED_CODE, ROOM_EXPIRED_REASON, SCRATCH_COALESCE_MS } from "../shared/guards";
import { actorReply } from "./ai";
import { Actor, isRecord } from "./actor";
import type { RpcResult } from "./race";
import type { ChatMessage, MemoryLabel, RoomView, SayResult, ServerEvent } from "../shared/types";
import { ACTOR_TTL_MS, MESSAGE_MAX, NAME_MAX, ROOM_MESSAGES, ROOM_SOCKETS, SCRATCH_MAX } from "../shared/types";

type ChatState = {
  ready: boolean;
  createdAt: number;
  touchedAt: number;
  aiUntil: number;
  messages: ChatMessage[];
  says: number[];
};

type SocketMeta = { name: string; ip: string; frames: number[]; scratchAt: number[] };

function fail(status: number, code: string, message: string): RpcResult<never> {
  return { ok: false, status, code, message };
}

export function cleanName(value: unknown): string {
  if (typeof value !== "string") return "Guest";
  const cleaned = value.replace(/[\u0000-\u001f]/g, "").trim().slice(0, NAME_MAX);
  if (!cleaned || isReservedName(cleaned)) return "Guest";
  return cleaned;
}

export function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function isMessage(value: unknown): value is ChatMessage {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.at === "number" &&
    typeof value.name === "string" &&
    (value.role === "human" || value.role === "actor") &&
    typeof value.text === "string" &&
    (value.source === "" || value.source === "workers-ai" || value.source === "fallback" || value.source === undefined)
  );
}

function clipMessage(message: ChatMessage): ChatMessage {
  return {
    id: message.id.slice(0, 80),
    at: message.at,
    name: clipSpeakerName(message.role, cleanName(message.name)),
    role: message.role,
    text: cleanText(message.text, MESSAGE_MAX),
    source: message.source === "workers-ai" || message.source === "fallback" ? message.source : "",
  };
}

export class ChatActor extends Actor<ChatState> {
  /** Ephemeral on purpose: a real eviction drops isolate memory and keeps SQLite. */
  #scratch = "";
  #memory: MemoryLabel = "fresh";
  #scratchFlush: ReturnType<typeof setTimeout> | null = null;

  protected initial(): ChatState {
    return { ready: false, createdAt: 0, touchedAt: 0, aiUntil: 0, messages: [], says: [] };
  }

  protected override afterLoad(): void {
    if (typeof this.state.ready !== "boolean") this.state.ready = false;
    if (typeof this.state.createdAt !== "number") this.state.createdAt = 0;
    if (typeof this.state.touchedAt !== "number") this.state.touchedAt = 0;
    if (typeof this.state.aiUntil !== "number") this.state.aiUntil = 0;
    const rawSays = Array.isArray(this.state.says) ? this.state.says : [];
    const says = rawSays.filter((at): at is number => typeof at === "number");
    if (says.length !== rawSays.length) this.state.says = says;
    const raw = Array.isArray(this.state.messages) ? this.state.messages : [];
    const clean = raw.filter(isMessage).slice(-ROOM_MESSAGES).map(clipMessage);
    if (JSON.stringify(clean) !== JSON.stringify(this.state.messages)) this.state.messages = clean;
    this.#memory = clean.length > 0 ? "woke" : "fresh";
  }

  protected override touchedAt(): number {
    return this.state.touchedAt;
  }

  protected override beforeExpire(): void {
    this.#scratch = "";
    this.#cancelScratch();
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(ROOM_EXPIRED_CODE, ROOM_EXPIRED_REASON);
      } catch {
        // Already gone.
      }
    }
  }

  async init(now: number): Promise<RpcResult<RoomView>> {
    return this.mailbox(async () => {
      if (!this.state.ready) {
        this.state.ready = true;
        this.state.createdAt = now;
        this.state.messages = [];
        this.state.says = [];
      }
      this.state.touchedAt = now;
      await this.ctx.storage.setAlarm(now + ACTOR_TTL_MS);
      return { ok: true as const, data: this.#view() };
    });
  }

  async view(): Promise<RpcResult<RoomView>> {
    if (!this.state.ready) return fail(404, "not_found", "Unknown room.");
    return { ok: true, data: this.#view() };
  }

  async grantAi(until: number): Promise<RpcResult<RoomView>> {
    if (!this.state.ready) return fail(404, "not_found", "Unknown room.");
    return this.mailbox(async () => {
      this.state.aiUntil = until;
      this.state.touchedAt = Date.now();
      await this.ctx.storage.setAlarm(Date.now() + ACTOR_TTL_MS);
      return { ok: true as const, data: this.#view() };
    });
  }

  async setScratch(text: string): Promise<RpcResult<RoomView>> {
    if (!this.state.ready) return fail(404, "not_found", "Unknown room.");
    this.#queueScratch(cleanText(text, SCRATCH_MAX));
    return { ok: true, data: this.#view() };
  }

  async say(input: { name: string; text: string; ask: boolean; ip?: string }): Promise<RpcResult<SayResult>> {
    if (!this.state.ready) return fail(404, "not_found", "Unknown room.");
    return this.mailbox(() => this.#say(input.name, input.text, input.ask, input.ip ?? "local"));
  }

  async evict(): Promise<RpcResult<RoomView>> {
    if (!this.state.ready) return fail(404, "not_found", "Unknown room.");
    return this.mailbox(async () => {
      this.#scratch = "";
      this.#cancelScratch();
      this.reloadState();
      this.#memory = "reloaded";
      const room = this.#view();
      this.#broadcast({ type: "evicted", room });
      console.log(JSON.stringify({ event: "chat_evict", messages: room.messages.length }));
      return { ok: true as const, data: room };
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({ error: { code: "upgrade_required", message: "Expected a WebSocket upgrade." } }, { status: 426 });
    }
    if (!this.state.ready) {
      return Response.json({ error: { code: "not_found", message: "Unknown room." } }, { status: 404 });
    }
    if (this.livePeers() >= ROOM_SOCKETS) {
      return Response.json({ error: { code: "room_full", message: "This room already has 8 sockets." } }, { status: 429 });
    }
    const url = new URL(request.url);
    const name = cleanName(url.searchParams.get("name"));
    const ip = (request.headers.get("cf-connecting-ip") ?? "local").slice(0, 64);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ name, ip, frames: [], scratchAt: [] } satisfies SocketMeta);
    // Hibernated actors stay asleep for a raw ping. JSON still wakes onMessage.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    const peers = this.livePeers();
    server.send(JSON.stringify({ type: "hello", you: name, peers, room: this.#view() } satisfies ServerEvent));
    this.#broadcast({ type: "peers", peers }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const meta = attachment(ws);
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    if (text === "ping") return;
    const admitted = admitFrame(meta.frames, Date.now());
    meta.frames = admitted.frames;
    ws.serializeAttachment(meta);
    if (!admitted.ok) {
      try {
        ws.close(1008, "Too many frames");
      } catch {
        // Already closing.
      }
      return;
    }
    if (text.length > 8_000) {
      this.#send(ws, { type: "error", code: "too_large", message: "That message is too large." });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      this.#send(ws, { type: "error", code: "invalid_json", message: "Expected JSON." });
      return;
    }
    if (!isRecord(parsed)) {
      this.#send(ws, { type: "error", code: "invalid", message: "Expected a JSON object." });
      return;
    }
    if (parsed.type === "scratch") {
      const scratch = admitScratch(meta.scratchAt, Date.now());
      meta.scratchAt = scratch.frames;
      ws.serializeAttachment(meta);
      if (!scratch.ok) return;
      this.#queueScratch(cleanText(parsed.text, SCRATCH_MAX));
      return;
    }
    if (parsed.type !== "say") {
      this.#send(ws, { type: "error", code: "invalid", message: "Unknown socket message." });
      return;
    }
    if (!(await this.#limitIp(meta.ip, "chat"))) {
      this.#send(ws, { type: "error", code: "rate_limited", message: "Too many chat. Wait a minute." });
      return;
    }
    const said = cleanText(parsed.text, MESSAGE_MAX + 1);
    if (!said) {
      this.#send(ws, { type: "error", code: "invalid", message: "Write a message first." });
      return;
    }
    if (said.length > MESSAGE_MAX) {
      this.#send(ws, { type: "error", code: "too_large", message: "Messages must be 500 characters or fewer." });
      return;
    }
    const result = await this.mailbox(() => this.#say(meta.name, said, parsed.ask === true, meta.ip));
    if (!result.ok) {
      this.#send(ws, { type: "error", code: result.code, message: result.message });
      return;
    }
    this.#broadcast({
      type: "said",
      human: result.data.human,
      actor: result.data.actor,
      peers: this.livePeers(),
      room: result.data.room,
    });
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    try {
      ws.close();
    } catch {
      // Already closed.
    }
    this.#broadcast({ type: "peers", peers: this.livePeers(ws) });
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, "error");
    } catch {
      // Already closed.
    }
  }

  livePeers(except?: WebSocket): number {
    return livePeers(this.ctx.getWebSockets(), except);
  }

  async #say(name: string, text: string, ask: boolean, ip: string): Promise<RpcResult<SayResult>> {
    const body = cleanText(text, MESSAGE_MAX + 1);
    if (!body) return fail(400, "invalid", "Write a message first.");
    if (body.length > MESSAGE_MAX) return fail(413, "too_large", "Messages must be 500 characters or fewer.");
    if (ask && this.state.aiUntil < Date.now()) {
      return fail(403, "turnstile_required", "Unlock the actor with Turnstile before asking it.");
    }
    if (ask && !(await this.#limitAi(ip))) {
      return fail(429, "rate_limited", "Too many AI calls. Wait a minute.");
    }
    if (!this.#allowSay()) return fail(429, "rate_limited", "This room is taking messages too quickly. Wait a minute.");
    const human: ChatMessage = {
      id: crypto.randomUUID(),
      at: Date.now(),
      name: cleanName(name),
      role: "human",
      text: body,
      source: "",
    };
    this.state.messages = [...this.state.messages, human].slice(-ROOM_MESSAGES);
    this.state.touchedAt = Date.now();
    let actor: ChatMessage | null = null;
    if (ask) {
      const reply = await actorReply(
        this.env,
        this.state.messages.map((message) => ({ name: message.name, role: message.role, text: message.text })),
      );
      actor = {
        id: crypto.randomUUID(),
        at: Date.now(),
        name: "Actor",
        role: "actor",
        text: reply.text,
        source: reply.source,
      };
      this.state.messages = [...this.state.messages, actor].slice(-ROOM_MESSAGES);
      this.state.touchedAt = Date.now();
    }
    await this.ctx.storage.setAlarm(Date.now() + ACTOR_TTL_MS);
    // Socket sends are not the HTTP response. Confirm the rows before announcing them.
    await this.ctx.storage.sync();
    console.log(JSON.stringify({ event: "chat_say", chars: body.length, ask, source: actor?.source ?? "none" }));
    return { ok: true, data: { human, actor, room: this.#view() } };
  }

  #allowSay(): boolean {
    const admitted = admitSay(this.state.says ?? [], Date.now());
    this.state.says = admitted.says;
    return admitted.ok;
  }

  async #limitIp(ip: string, label: string): Promise<boolean> {
    const { success } = await this.env.CHAT_LIMIT.limit({ key: ip.slice(0, 64) });
    if (!success) {
      console.warn(JSON.stringify({ event: "chat_limited", label, ip }));
    }
    return success;
  }

  async #limitAi(ip: string): Promise<boolean> {
    const { success } = await this.env.AI_LIMIT.limit({ key: ip.slice(0, 64) });
    return success;
  }

  #view(): RoomView {
    return {
      ready: this.state.ready,
      messages: this.state.messages.map((message) => ({ ...message })),
      scratch: this.#scratch,
      peers: this.livePeers(),
      aiUntil: this.state.aiUntil,
      memory: this.#memory,
      touchedAt: this.state.touchedAt,
      expiresAt: (this.state.touchedAt || Date.now()) + ACTOR_TTL_MS,
      createdAt: this.state.createdAt,
    };
  }

  #queueScratch(text: string): void {
    this.#scratch = text;
    if (this.#scratchFlush) return;
    this.#scratchFlush = setTimeout(() => {
      this.#scratchFlush = null;
      this.#broadcast({ type: "scratch", text: this.#scratch });
    }, SCRATCH_COALESCE_MS);
  }

  #cancelScratch(): void {
    if (this.#scratchFlush) {
      clearTimeout(this.#scratchFlush);
      this.#scratchFlush = null;
    }
  }

  #broadcast(event: ServerEvent, except?: WebSocket): void {
    const data = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except || ws.readyState !== WebSocket.OPEN) continue;
      try {
        ws.send(data);
      } catch {
        // A closing socket should not fail the room.
      }
    }
  }

  #send(ws: WebSocket, event: ServerEvent): void {
    try {
      ws.send(JSON.stringify(event));
    } catch {
      // Ignore a socket that closed while we were writing the error.
    }
  }
}

function attachment(ws: WebSocket): SocketMeta {
  const raw = ws.deserializeAttachment() as unknown;
  if (isRecord(raw) && typeof raw.name === "string") {
    const frames = Array.isArray(raw.frames) ? raw.frames.filter((at): at is number => typeof at === "number") : [];
    const scratchAt = Array.isArray(raw.scratchAt) ? raw.scratchAt.filter((at): at is number => typeof at === "number") : [];
    const ip = typeof raw.ip === "string" && raw.ip ? raw.ip.slice(0, 64) : "local";
    return { name: cleanName(raw.name), ip, frames, scratchAt };
  }
  return { name: "Guest", ip: "local", frames: [], scratchAt: [] };
}
