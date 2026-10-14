import { DurableObject } from "cloudflare:workers";
import {
  COLLECT_RADIUS,
  COUNTDOWN_MS,
  FRAME_BURST,
  FRAME_MAX_BYTES,
  FRAME_RATE,
  IDLE_MS,
  MAX_PLAYERS,
  MAX_SOCKETS_PER_IP,
  MAX_SPEED,
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
  lastSeen: number;
  ipHash: string;
  tokens: number;
  tokenAt: number;
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

const COLLECT_R2 = COLLECT_RADIUS * COLLECT_RADIUS;
const IDLE_CHECK_MS = 60_000;

function jsonEvent(event: ServerEvent): string {
  return JSON.stringify(event);
}

function parseClient(raw: string): ClientEvent | null {
  try {
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const rec = data as { type?: unknown; x?: unknown; z?: unknown };
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

function takeToken(state: SocketState, now: number): boolean {
  const elapsed = Math.max(0, (now - state.tokenAt) / 1000);
  state.tokens = Math.min(FRAME_BURST, state.tokens + elapsed * FRAME_RATE);
  state.tokenAt = now;
  if (state.tokens < 1) return false;
  state.tokens -= 1;
  return true;
}

export class VibeRoom extends DurableObject<Env> {
  private game: GameSnap = emptyGame();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
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
      await this.armIdleAlarm();
      return;
    }
    await this.kickIdle(now);
  }

  private rejectSocket(message: string, code: number, reason: string): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    server.send(jsonEvent({ type: "error", message }));
    try {
      server.close(code, reason);
    } catch {
      /* already closed */
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  private acceptClient(request: Request): Response {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length >= MAX_PLAYERS) {
      return this.rejectSocket("This room is full (8). Try another name.", 4001, "full");
    }

    const ipHash = request.headers.get("x-goodvibes-ip") || "";
    if (ipHash) {
      let sameIp = 0;
      for (const ws of sockets) {
        const attached = ws.deserializeAttachment() as SocketState | null;
        if (attached?.ipHash === ipHash) sameIp += 1;
      }
      if (sameIp >= MAX_SOCKETS_PER_IP) {
        return this.rejectSocket("This address already has 2 players in the room.", 4003, "ip");
      }
    }

    const room = request.headers.get("x-goodvibes-room") || "lobby";
    const id = crypto.randomUUID();
    const name = sanitizeName(request.headers.get("x-goodvibes-name"));
    const color = colorForId(id);
    const spawn = spawnPoint(sockets.length, sockets.length + 1);
    const now = Date.now();

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);

    const state: SocketState = {
      id,
      name,
      color,
      x: spawn.x,
      z: spawn.z,
      score: 0,
      lastMove: 0,
      lastSeen: now,
      ipHash,
      tokens: FRAME_BURST,
      tokenAt: now,
    };
    server.serializeAttachment(state);
    this.game.scores[id] = 0;

    const you = this.toPlayer(state);
    const hello: ServerEvent = {
      type: "hello",
      room,
      you,
      players: this.players(),
      round: this.roundState(),
      serverNow: now,
    };
    server.send(jsonEvent(hello));
    this.broadcast({ type: "join", player: you }, server);
    this.broadcast({ type: "presence", players: this.players() });
    void this.persist();
    void this.armIdleAlarm();

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    if (message.length > FRAME_MAX_BYTES) return;
    const state = ws.deserializeAttachment() as SocketState | null;
    if (!state) return;
    const now = Date.now();
    if (!takeToken(state, now)) {
      try {
        ws.close(1008, "slow down");
      } catch {
        /* already closed */
      }
      return;
    }
    state.lastSeen = now;
    ws.serializeAttachment(state);

    const event = parseClient(message);
    if (!event) {
      ws.send(jsonEvent({ type: "error", message: "That frame was not a move or start." }));
      return;
    }
    if (event.type === "start") {
      await this.startRound(ws);
      return;
    }

    const dt = Math.min(now - state.lastMove, 250);
    const budget = (MAX_SPEED * (state.lastMove === 0 ? 250 : dt)) / 1000 + 0.05;
    const dx = event.x - state.x;
    const dz = event.z - state.z;
    const d = Math.hypot(dx, dz);
    const k = d > budget ? budget / d : 1;
    state.x = clampPos(state.x + dx * k);
    state.z = clampPos(state.z + dz * k);
    state.lastMove = now;
    ws.serializeAttachment(state);
    this.broadcast({ type: "move", id: state.id, x: state.x, z: state.z }, ws);

    if (this.game.phase === "playing") await this.tryCollect(ws, state);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.drop(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.drop(ws);
  }

  private async drop(ws: WebSocket): Promise<void> {
    const state = ws.deserializeAttachment() as SocketState | null;
    try {
      ws.close(1000, "bye");
    } catch {
      /* echoing 1005/1006 throws */
    }
    if (state?.id) this.broadcast({ type: "leave", id: state.id }, ws);
    this.broadcast({ type: "presence", players: this.players(ws) }, ws);
    if (this.ctx.getWebSockets().every((s) => s === ws)) {
      this.game = emptyGame();
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
    }
  }

  private async startRound(ws: WebSocket): Promise<void> {
    if (this.game.phase === "countdown" || this.game.phase === "playing") {
      ws.send(jsonEvent({ type: "error", message: "A round is already underway." }));
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
    this.broadcast({ type: "round", round: this.roundState(), players: this.players(), serverNow: Date.now() });
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
    this.broadcast({ type: "round", round: this.roundState(), players: this.players(), serverNow: Date.now() });
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
    this.broadcast({ type: "round", round: this.roundState(), players: this.players(), serverNow: Date.now() });
  }

  private async tryCollect(ws: WebSocket, state: SocketState): Promise<void> {
    const hit = this.game.orbs.find((orb) => dist2(state.x, state.z, orb.x, orb.z) <= COLLECT_R2);
    if (!hit) return;
    const pts = pointsFor(hit.kind);
    state.score += pts;
    this.game.scores[state.id] = state.score;
    ws.serializeAttachment(state);
    this.game.orbs = this.game.orbs.filter((o) => o.id !== hit.id);
    this.game.orbs.push(this.spawnOrb(hit.kind === "hot"));
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

  private listedSockets(exclude?: WebSocket): { ws: WebSocket; state: SocketState }[] {
    const out: { ws: WebSocket; state: SocketState }[] = [];
    const seen = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (exclude && ws === exclude) continue;
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

  private players(exclude?: WebSocket): Player[] {
    return this.listedSockets(exclude).map((row) => this.toPlayer(row.state));
  }

  private scoreboard(exclude?: WebSocket): ScoreRow[] {
    return this.players(exclude)
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
      serverNow: Date.now(),
      orbs: this.game.orbs,
      scores: board,
      winner,
    };
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put("game", this.game);
  }

  private async armIdleAlarm(): Promise<void> {
    if (this.game.phase === "countdown" || this.game.phase === "playing") return;
    if (this.ctx.getWebSockets().length === 0) return;
    const existing = await this.ctx.storage.getAlarm();
    const when = Date.now() + IDLE_CHECK_MS;
    if (existing && existing <= when) return;
    await this.ctx.storage.setAlarm(when);
  }

  private async kickIdle(now: number): Promise<void> {
    if (this.game.phase !== "waiting" && this.game.phase !== "over") return;
    for (const { ws, state } of this.listedSockets()) {
      if (now - state.lastSeen <= IDLE_MS) continue;
      try {
        ws.close(1000, "idle");
      } catch {
        /* already closed */
      }
      await this.drop(ws);
    }
    await this.armIdleAlarm();
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
