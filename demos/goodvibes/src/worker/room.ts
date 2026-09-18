import { DurableObject } from "cloudflare:workers";
import {
  COLLECT_RADIUS,
  COUNTDOWN_MS,
  MAX_PLAYERS,
  ORB_COUNT,
  ROUND_MS,
  clampPos,
  colorForId,
  dist2,
  pointsFor,
  sanitizeName,
  type ClientEvent,
  type Orb,
  type Phase,
  type Player,
  type RoundState,
  type ScoreRow,
  type ServerEvent,
} from "../shared/types";

type SocketState = {
  id: string;
  name: string;
  color: string;
  x: number;
  z: number;
  score: number;
  lastMove: number;
};

type GameSnap = {
  phase: Phase;
  round: number;
  endsAt: number;
  orbs: Orb[];
  scores: Record<string, number>;
  winnerId: string | null;
  nextOrb: number;
};

const MOVE_MIN_MS = 32;
const COLLECT_R2 = COLLECT_RADIUS * COLLECT_RADIUS;

function jsonEvent(event: ServerEvent): string {
  return JSON.stringify(event);
}

function parseClient(raw: string): ClientEvent | null {
  try {
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const rec = data as { type?: unknown; x?: unknown; z?: unknown };
    if (rec.type === "ping") return { type: "ping" };
    if (rec.type === "start") return { type: "start" };
    if (rec.type === "move") return { type: "move", x: clampPos(rec.x), z: clampPos(rec.z) };
    return null;
  } catch {
    return null;
  }
}

function spawnPoint(index: number, count: number): { x: number; z: number } {
  const n = Math.max(count, 1);
  const angle = (index / n) * Math.PI * 2 - Math.PI / 2;
  const radius = 8.2;
  return { x: clampPos(Math.cos(angle) * radius), z: clampPos(Math.sin(angle) * radius) };
}

function emptyGame(): GameSnap {
  return { phase: "waiting", round: 0, endsAt: 0, orbs: [], scores: {}, winnerId: null, nextOrb: 1 };
}

export class VibeRoom extends DurableObject<Env> {
  private game: GameSnap = emptyGame();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      const saved = await this.ctx.storage.get<GameSnap>("game");
      if (saved) this.game = saved;
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") === "websocket") {
      return this.acceptClient(request);
    }
    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    if (this.game.phase === "countdown" && now >= this.game.endsAt) {
      await this.beginPlay();
      return;
    }
    if (this.game.phase === "playing" && now >= this.game.endsAt) {
      await this.endRound();
    }
  }

  private acceptClient(request: Request): Response {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length >= MAX_PLAYERS) {
      return new Response("This lobby is full (8).", { status: 503 });
    }

    const room = request.headers.get("x-goodvibes-room") || "lobby";
    const id = request.headers.get("x-goodvibes-id") || crypto.randomUUID();
    const name = sanitizeName(request.headers.get("x-goodvibes-name"));
    const color = colorForId(id);
    const spawn = spawnPoint(sockets.length, sockets.length + 1);
    const score = this.game.scores[id] ?? 0;

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);

    const state: SocketState = { id, name, color, x: spawn.x, z: spawn.z, score, lastMove: 0 };
    server.serializeAttachment(state);
    if (this.game.scores[id] === undefined) this.game.scores[id] = score;

    const you = this.toPlayer(state);
    const hello: ServerEvent = { type: "hello", room, you, players: this.players(), round: this.roundState() };
    server.send(jsonEvent(hello));
    this.broadcast({ type: "join", player: you }, server);
    this.broadcast({ type: "presence", players: this.players() });
    void this.persist();

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    const state = ws.deserializeAttachment() as SocketState | null;
    if (!state) return;
    const event = parseClient(message);
    if (!event) {
      ws.send(jsonEvent({ type: "error", message: "That frame was not a move, start, or ping." }));
      return;
    }
    if (event.type === "ping") {
      ws.send(jsonEvent({ type: "pong" }));
      return;
    }
    if (event.type === "start") {
      await this.startRound(ws);
      return;
    }

    const now = Date.now();
    if (now - state.lastMove < MOVE_MIN_MS) return;
    const dx = event.x - state.x;
    const dz = event.z - state.z;
    if (dx * dx + dz * dz > 100) return;

    state.x = event.x;
    state.z = event.z;
    state.lastMove = now;
    ws.serializeAttachment(state);
    this.broadcast({ type: "move", id: state.id, x: state.x, z: state.z }, ws);

    if (this.game.phase === "playing") await this.tryCollect(ws, state);
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
    if (this.ctx.getWebSockets().length === 0) {
      this.game = emptyGame();
      await this.ctx.storage.delete("game");
      await this.ctx.storage.deleteAlarm();
    }
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

  private async startRound(ws: WebSocket): Promise<void> {
    if (this.game.phase === "countdown" || this.game.phase === "playing") {
      ws.send(jsonEvent({ type: "error", message: "A round is already underway." }));
      return;
    }
    if (this.ctx.getWebSockets().length < 1) {
      ws.send(jsonEvent({ type: "error", message: "Need at least one player." }));
      return;
    }
    this.game.round += 1;
    this.game.phase = "countdown";
    this.game.endsAt = Date.now() + COUNTDOWN_MS;
    this.game.orbs = [];
    this.game.winnerId = null;
    this.game.scores = {};
    for (const p of this.players()) this.game.scores[p.id] = 0;
    this.syncScoresOntoSockets();
    await this.persist();
    await this.ctx.storage.setAlarm(this.game.endsAt);
    this.broadcast({ type: "round", round: this.roundState(), players: this.players() });
  }

  private async beginPlay(): Promise<void> {
    this.game.phase = "playing";
    this.game.endsAt = Date.now() + ROUND_MS;
    this.game.orbs = [];
    const list = this.listedSockets();
    list.forEach((row, i) => {
      const spawn = spawnPoint(i, list.length);
      row.state.x = spawn.x;
      row.state.z = spawn.z;
      row.state.score = 0;
      row.ws.serializeAttachment(row.state);
    });
    this.fillOrbs();
    await this.persist();
    await this.ctx.storage.setAlarm(this.game.endsAt);
    this.broadcast({ type: "round", round: this.roundState(), players: this.players() });
  }

  private async endRound(): Promise<void> {
    this.game.phase = "over";
    this.game.orbs = [];
    const board = this.scoreboard();
    const top = board[0];
    const tied = top && board.filter((s) => s.score === top.score).length > 1;
    this.game.winnerId = tied || !top || top.score <= 0 ? null : top.id;
    await this.persist();
    await this.ctx.storage.deleteAlarm();
    this.broadcast({ type: "round", round: this.roundState(), players: this.players() });
  }

  private async tryCollect(ws: WebSocket, state: SocketState): Promise<void> {
    const hit = this.game.orbs.find((orb) => dist2(state.x, state.z, orb.x, orb.z) <= COLLECT_R2);
    if (!hit) return;
    const pts = pointsFor(hit.kind);
    state.score += pts;
    this.game.scores[state.id] = state.score;
    ws.serializeAttachment(state);
    this.game.orbs = this.game.orbs.filter((o) => o.id !== hit.id);
    this.game.orbs.push(this.spawnOrb(hit.kind === "hot" || Math.random() < 0.18));
    await this.persist();
    this.broadcast({
      type: "collect",
      playerId: state.id,
      orbId: hit.id,
      kind: hit.kind,
      score: state.score,
      orbs: this.game.orbs,
      scores: this.scoreboard(),
    });
  }

  private fillOrbs(): void {
    this.game.orbs = [];
    this.game.orbs.push(this.spawnOrb(true));
    while (this.game.orbs.length < ORB_COUNT) this.game.orbs.push(this.spawnOrb(false));
  }

  private spawnOrb(hot: boolean): Orb {
    const id = `o${this.game.nextOrb++}`;
    const kind = hot ? "hot" : "ember";
    for (let i = 0; i < 24; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = 2.4 + Math.random() * 8.2;
      const x = clampPos(Math.cos(angle) * radius);
      const z = clampPos(Math.sin(angle) * radius);
      const farOrbs = this.game.orbs.every((o) => dist2(x, z, o.x, o.z) > 4);
      const farPlayers = this.players().every((p) => dist2(x, z, p.x, p.z) > 2.2);
      if (farOrbs && farPlayers) return { id, x, z, kind };
    }
    return { id, x: 0, z: 0, kind };
  }

  private syncScoresOntoSockets(): void {
    for (const { ws, state } of this.listedSockets()) {
      state.score = this.game.scores[state.id] ?? 0;
      ws.serializeAttachment(state);
    }
  }

  private listedSockets(): { ws: WebSocket; state: SocketState }[] {
    const out: { ws: WebSocket; state: SocketState }[] = [];
    const seen = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const state = ws.deserializeAttachment() as SocketState | null;
      if (!state?.id || seen.has(state.id)) continue;
      seen.add(state.id);
      out.push({ ws, state });
    }
    return out;
  }

  private toPlayer(state: SocketState): Player {
    return {
      id: state.id,
      name: state.name,
      color: state.color,
      x: state.x,
      z: state.z,
      score: this.game.scores[state.id] ?? state.score,
    };
  }

  private players(): Player[] {
    return this.listedSockets().map((row) => this.toPlayer(row.state));
  }

  private scoreboard(): ScoreRow[] {
    return this.players()
      .map((p) => ({ id: p.id, name: p.name, color: p.color, score: p.score }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }

  private roundState(): RoundState {
    const board = this.scoreboard();
    const winner = this.game.winnerId ? (board.find((s) => s.id === this.game.winnerId) ?? null) : null;
    return {
      phase: this.game.phase,
      round: this.game.round,
      endsAt: this.game.endsAt,
      orbs: this.game.orbs,
      scores: board,
      winner,
    };
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put("game", this.game);
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
