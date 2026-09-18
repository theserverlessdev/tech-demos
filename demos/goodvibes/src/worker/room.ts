import { DurableObject } from "cloudflare:workers";
import {
  MAX_PLAYERS,
  clampPos,
  colorForId,
  sanitizeName,
  type ClientEvent,
  type Player,
  type ServerEvent,
} from "../shared/types";

type SocketState = {
  id: string;
  name: string;
  color: string;
  x: number;
  z: number;
  lastMove: number;
};

const MOVE_MIN_MS = 40;

function jsonEvent(event: ServerEvent): string {
  return JSON.stringify(event);
}

function parseClient(raw: string): ClientEvent | null {
  try {
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const rec = data as { type?: unknown; x?: unknown; z?: unknown };
    if (rec.type === "ping") return { type: "ping" };
    if (rec.type === "move") return { type: "move", x: clampPos(rec.x), z: clampPos(rec.z) };
    return null;
  } catch {
    return null;
  }
}

function spawnPoint(index: number): { x: number; z: number } {
  const angle = (index * 2.4) % (Math.PI * 2);
  const radius = 3 + (index % 4) * 0.7;
  return {
    x: clampPos(Math.cos(angle) * radius),
    z: clampPos(Math.sin(angle) * radius),
  };
}

export class VibeRoom extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") === "websocket") {
      return this.acceptClient(request);
    }
    return new Response("Not found", { status: 404 });
  }

  private acceptClient(request: Request): Response {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length >= MAX_PLAYERS) {
      return new Response("This lobby is full.", { status: 503 });
    }

    const room = request.headers.get("x-goodvibes-room") || "lobby";
    const id = request.headers.get("x-goodvibes-id") || crypto.randomUUID();
    const name = sanitizeName(request.headers.get("x-goodvibes-name"));
    const color = colorForId(id);
    const spawn = spawnPoint(sockets.length);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);

    const state: SocketState = { id, name, color, x: spawn.x, z: spawn.z, lastMove: 0 };
    server.serializeAttachment(state);

    const you = this.toPlayer(state);
    const hello: ServerEvent = { type: "hello", room, you, players: this.players() };
    server.send(jsonEvent(hello));
    this.broadcast({ type: "join", player: you }, server);
    this.broadcast({ type: "presence", players: this.players() });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    const state = ws.deserializeAttachment() as SocketState | null;
    if (!state) return;
    const event = parseClient(message);
    if (!event) {
      ws.send(jsonEvent({ type: "error", message: "That frame was not a move or ping." }));
      return;
    }
    if (event.type === "ping") {
      ws.send(jsonEvent({ type: "pong" }));
      return;
    }

    const now = Date.now();
    if (now - state.lastMove < MOVE_MIN_MS) return;
    const dx = event.x - state.x;
    const dz = event.z - state.z;
    // Ignore teleport-sized jumps (keep the floor readable).
    if (dx * dx + dz * dz > 100) return;

    state.x = event.x;
    state.z = event.z;
    state.lastMove = now;
    ws.serializeAttachment(state);
    this.broadcast({ type: "move", id: state.id, x: state.x, z: state.z }, ws);
  }


  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const state = ws.deserializeAttachment() as SocketState | null;
    try {
      ws.close(code, reason);
    } catch {
      /* already closed */
    }
    if (state?.id) this.broadcast({ type: "leave", id: state.id });
    this.broadcast({ type: "presence", players: this.players() });
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, "error");
    } catch {
      /* already closed */
    }
    const state = ws.deserializeAttachment() as SocketState | null;
    if (state?.id) this.broadcast({ type: "leave", id: state.id });
    this.broadcast({ type: "presence", players: this.players() });
  }

  private toPlayer(state: SocketState): Player {
    return { id: state.id, name: state.name, color: state.color, x: state.x, z: state.z };
  }

  private players(): Player[] {
    const out: Player[] = [];
    const seen = new Set<string>();
    for (const client of this.ctx.getWebSockets()) {
      const state = client.deserializeAttachment() as SocketState | null;
      if (!state?.id || seen.has(state.id)) continue;
      seen.add(state.id);
      out.push(this.toPlayer(state));
    }
    return out;
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
