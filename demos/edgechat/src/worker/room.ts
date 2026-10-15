import { DurableObject } from "cloudflare:workers";
import type { ChatMessage, ClientEvent, Presence, RoomSummary, ServerEvent, Session } from "../shared/types";
import { MAX_BODY, MAX_FRAME } from "../shared/types";
import { insertMessage, listMessages } from "./db";
import { newBucket, noteStrike, sessionWriteKey, STRIKE_LIMIT, takeToken, type TokenBucket } from "./limits";
import { sanitizeName } from "./session";

type SocketState = {
  publicId: string;
  displayName: string;
  roomId: string;
  ip: string;
  bucket: TokenBucket;
};

const PING = '{"type":"ping"}';
const PONG = '{"type":"pong"}';

function jsonEvent(event: ServerEvent): string {
  return JSON.stringify(event);
}

function parseClient(raw: string): ClientEvent | null {
  try {
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const rec = data as { type?: unknown; body?: unknown };
    if (rec.type === "ping") return { type: "ping" };
    if (rec.type === "send" && typeof rec.body === "string") return { type: "send", body: rec.body };
    return null;
  } catch {
    return null;
  }
}

function decodeHeader(raw: string | null): string {
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function decodeName(raw: string | null): string {
  return sanitizeName(decodeHeader(raw) || "Guest");
}

export class ChatRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") === "websocket") {
      return this.acceptClient(request);
    }

    if (request.method === "POST" && url.pathname.endsWith("/broadcast")) {
      const payload = (await request.json()) as ServerEvent;
      this.broadcast(payload);
      return Response.json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  }

  private async acceptClient(request: Request): Promise<Response> {
    const roomId = decodeHeader(request.headers.get("x-edgechat-room")) || "lobby";
    const publicId = request.headers.get("x-edgechat-public") ?? crypto.randomUUID();
    const displayName = decodeName(request.headers.get("x-edgechat-name"));
    const ip = request.headers.get("x-edgechat-ip") || "local";
    const roomJson = decodeHeader(request.headers.get("x-edgechat-room-json"));

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const state: SocketState = { publicId, displayName, roomId, ip, bucket: newBucket() };
    server.serializeAttachment(state);

    let room: RoomSummary;
    if (roomJson) {
      try {
        room = JSON.parse(roomJson) as RoomSummary;
      } catch {
        room = { id: roomId, name: roomId, createdAt: Date.now(), lastMessageAt: 0, lastPreview: "", messageCount: 0 };
      }
    } else {
      room = { id: roomId, name: roomId, createdAt: Date.now(), lastMessageAt: 0, lastPreview: "", messageCount: 0 };
    }

    const messages = await listMessages(this.env, room.id);
    const you: Session = { publicId, displayName, createdAt: Date.now(), persisted: true };
    const hello: ServerEvent = { type: "hello", room, you, presence: this.presence(), messages };
    server.send(jsonEvent(hello));
    this.broadcastPresence();

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    const state = ws.deserializeAttachment() as SocketState | null;
    if (!state) return;

    if (message.length > MAX_FRAME) {
      this.strike(ws, state, "That frame is too large.");
      return;
    }

    const event = parseClient(message);
    if (!event) {
      this.strike(ws, state, "That frame was not a send or ping.");
      return;
    }
    if (event.type === "ping") {
      ws.send(PONG);
      return;
    }

    const allowed = takeToken(state.bucket);
    // Persist before any await so overlapping frames cannot refill from a stale bucket.
    ws.serializeAttachment(state);
    if (!allowed) {
      ws.send(jsonEvent({ type: "error", message: "Too many messages from this socket. Wait a few seconds." }));
      return;
    }

    const ip = await this.env.WRITE_LIMIT.limit({ key: state.ip });
    if (!ip.success) {
      ws.send(jsonEvent({ type: "error", message: "Too many writes from this address. Wait a minute." }));
      return;
    }
    const session = await this.env.WRITE_LIMIT.limit({ key: sessionWriteKey(state.publicId) });
    if (!session.success) {
      ws.send(jsonEvent({ type: "error", message: "Too many writes from this session. Wait a minute." }));
      return;
    }

    const body = event.body.replace(/\s+/g, " ").trim().slice(0, MAX_BODY);
    if (!body) {
      ws.send(jsonEvent({ type: "error", message: "Type a message first." }));
      return;
    }
    const saved = await insertMessage(this.env, {
      roomId: state.roomId,
      author: state.displayName,
      authorKey: state.publicId,
      body,
    });
    this.broadcast({ type: "message", message: saved.message, room: saved.room });
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.broadcast({ type: "presence", presence: this.presence(ws) }, ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.broadcast({ type: "presence", presence: this.presence(ws) }, ws);
  }

  private strike(ws: WebSocket, state: SocketState, message: string): void {
    noteStrike(state.bucket);
    ws.serializeAttachment(state);
    ws.send(jsonEvent({ type: "error", message }));
    if (state.bucket.strikes >= STRIKE_LIMIT) {
      try {
        ws.close(1008, "policy");
      } catch {
        /* already closed */
      }
    }
  }

  private presence(except?: WebSocket): Presence {
    const names: string[] = [];
    const seen = new Set<string>();
    let count = 0;
    for (const client of this.ctx.getWebSockets()) {
      if (client === except) continue;
      if (client.readyState !== WebSocket.OPEN && client.readyState !== WebSocket.CONNECTING) continue;
      count += 1;
      const state = client.deserializeAttachment() as SocketState | null;
      if (!state?.displayName || seen.has(state.publicId)) continue;
      seen.add(state.publicId);
      names.push(state.displayName);
    }
    return { count, names };
  }

  private broadcastPresence(): void {
    this.broadcast({ type: "presence", presence: this.presence() });
  }

  private broadcast(event: ServerEvent, except?: WebSocket): void {
    const data = jsonEvent(event);
    for (const client of this.ctx.getWebSockets()) {
      if (client === except) continue;
      try {
        client.send(data);
      } catch {
        /* dropped */
      }
    }
  }
}

export async function fanout(env: Env, roomId: string, message: ChatMessage, room: RoomSummary): Promise<void> {
  const id = env.ROOM.idFromName(roomId);
  const stub = env.ROOM.get(id);
  await stub.fetch("https://room/broadcast", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "message", message, room } satisfies ServerEvent),
  });
}
