import { DurableObject } from "cloudflare:workers";
import type { ChatMessage, ClientEvent, Presence, ServerEvent, Session } from "../shared/types";
import { ensureRoom, insertMessage, listMessages } from "./db";
import { sanitizeName } from "./session";

type SocketState = {
  sessionId: string;
  displayName: string;
  roomId: string;
};

const MAX_BODY = 2_000;

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

export class ChatRoom extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") === "websocket") {
      return this.acceptClient(request);
    }

    if (request.method === "POST" && url.pathname.endsWith("/broadcast")) {
      const payload = (await request.json()) as ServerEvent;
      this.broadcast(payload);
      if (payload.type === "message") this.broadcastPresence();
      return Response.json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  }

  private async acceptClient(request: Request): Promise<Response> {
    const roomId = request.headers.get("x-edgechat-room") ?? "lobby";
    const sessionId = request.headers.get("x-edgechat-session") ?? crypto.randomUUID();
    const displayName = sanitizeName(request.headers.get("x-edgechat-name") ?? "Guest");

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const state: SocketState = { sessionId, displayName, roomId };
    server.serializeAttachment(state);

    const room = await ensureRoom(this.env, roomId);
    const messages = await listMessages(this.env, room.id);
    const you: Session = { id: sessionId, displayName, createdAt: Date.now() };
    const hello: ServerEvent = { type: "hello", room, you, presence: this.presence(), messages };
    server.send(jsonEvent(hello));
    this.broadcastPresence();

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    const state = ws.deserializeAttachment() as SocketState | null;
    if (!state) return;
    const event = parseClient(message);
    if (!event) {
      ws.send(jsonEvent({ type: "error", message: "That frame was not a send or ping." }));
      return;
    }
    if (event.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
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
      sessionId: state.sessionId,
      body,
    });
    this.broadcast({ type: "message", message: saved });
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(code, reason);
    this.broadcastPresence();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, "error");
    } catch {
      /* already closed */
    }
    this.broadcastPresence();
  }

  private presence(): Presence {
    const names: string[] = [];
    const seen = new Set<string>();
    for (const client of this.ctx.getWebSockets()) {
      const state = client.deserializeAttachment() as SocketState | null;
      if (!state?.displayName || seen.has(state.sessionId)) continue;
      seen.add(state.sessionId);
      names.push(state.displayName);
    }
    return { count: this.ctx.getWebSockets().length, names };
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

export async function fanout(env: Env, roomId: string, message: ChatMessage): Promise<void> {
  const id = env.ROOM.idFromName(roomId);
  const stub = env.ROOM.get(id);
  await stub.fetch("https://room/broadcast", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "message", message } satisfies ServerEvent),
  });
}
