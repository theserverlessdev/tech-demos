import { DurableObject } from "cloudflare:workers";
import { admit, type Seat } from "../shared/admit";
import { freshBudget, takeFrame, takeSignal, MAX_BAD_FRAMES, type FrameBudget } from "../shared/budget";
import { iceServersFromEnv } from "../shared/ice";
import {
  CID,
  CLOSE_BAD_FRAME,
  CLOSE_EXPIRED,
  CLOSE_FULL,
  CLOSE_LIMIT,
  CLOSE_REPLACED,
  MAX_SIGNAL_BYTES,
  ROOM_TTL_MS,
  isExpired,
  type IceServer,
  type Role,
  type TapeEvent,
} from "../shared/protocol";
import { parseClientSignal, signalRoleOk, summarizeSignal } from "../shared/signal";
import type { Env } from "./env";

type Meta = {
  createdAt: number;
  expiresAt: number;
  creatorCid: string;
  tape: TapeEvent[];
  seq: number;
};

type Attachment = {
  cid: string;
  role: Role;
  silent?: boolean;
  budget: FrameBudget;
};

type Live = { ws: WebSocket; seat: Attachment };

const TAPE_LIMIT = 40;
const TAPE_BATCH = 8;

/**
 * Signalling room. WebSocket messages are offers, answers, and ICE candidates.
 * File bytes travel on the browsers' data channel and are not accepted here.
 * Rejected frames are not stored. Accepted tape lines are written in batches.
 */
export class PairRoom extends DurableObject<Env> {
  private meta: Meta | null = null;
  private dirty = 0;
  private lastFlushAt = 0;

  async create(input: { creatorCid: string; now: number }): Promise<{ expiresAt: number }> {
    if (!CID.test(input.creatorCid)) throw new Error("bad creator");
    const existing = await this.loadMeta();
    if (existing && !isExpired(existing.expiresAt, input.now)) throw new Error("exists");
    const expiresAt = input.now + ROOM_TTL_MS;
    const meta: Meta = {
      createdAt: input.now,
      expiresAt,
      creatorCid: input.creatorCid,
      tape: [],
      seq: 0,
    };
    this.meta = meta;
    this.dirty = 0;
    this.lastFlushAt = input.now;
    await this.ctx.storage.put("meta", meta);
    await this.ctx.storage.setAlarm(expiresAt);
    return { expiresAt };
  }

  async alarm(): Promise<void> {
    const meta = await this.loadMeta();
    if (meta) {
      const event = this.nextEvent(meta, "expire", 0, "room expired · signalling only");
      for (const row of this.live()) {
        this.send(row.ws, { type: "tape", event });
        this.send(row.ws, { type: "expired" });
        row.ws.close(CLOSE_EXPIRED, "Room expired");
      }
    }
    this.meta = null;
    this.dirty = 0;
    await this.ctx.storage.deleteAll();
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected websocket", { status: 426 });
    }
    const url = new URL(request.url);
    const cid = url.searchParams.get("cid") ?? "";
    if (!CID.test(cid)) return new Response("Bad peer", { status: 400 });

    const now = Date.now();
    const meta = await this.loadMeta();
    if (!meta || isExpired(meta.expiresAt, now)) {
      return this.reject(CLOSE_EXPIRED, "Room expired");
    }

    const seats: Seat[] = this.live().map((row) => ({ cid: row.seat.cid, role: row.seat.role }));
    const decision = admit(seats, cid, meta.creatorCid);
    if (!decision.ok) return this.reject(CLOSE_FULL, "Room full");

    if (decision.replaced) {
      for (const row of this.live()) {
        if (row.seat.cid !== cid) continue;
        row.ws.serializeAttachment({ ...row.seat, silent: true });
        row.ws.close(CLOSE_REPLACED, "Replaced");
      }
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    const seat: Attachment = { cid, role: decision.role, budget: freshBudget(now) };
    server.serializeAttachment(seat);

    const iceServers = iceServersFromEnv(this.env).servers;
    this.send(server, {
      type: "hello",
      role: decision.role,
      cid,
      peers: this.live().length,
      expiresAt: meta.expiresAt,
      tape: meta.tape,
      iceServers,
    });
    await this.note("join", 0, `join · ${decision.role} · signalling socket`, "now");
    this.announce();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const seat = ws.deserializeAttachment() as Attachment | null;
    if (!seat || seat.silent) return;
    const meta = await this.loadMeta();
    if (!meta || isExpired(meta.expiresAt, Date.now())) {
      this.send(ws, { type: "expired" });
      ws.close(CLOSE_EXPIRED, "Room expired");
      return;
    }
    if (typeof message !== "string") {
      ws.close(CLOSE_BAD_FRAME, "Binary frames are not signalling");
      return;
    }
    if (message.length > MAX_SIGNAL_BYTES) {
      ws.close(CLOSE_LIMIT, "Signalling frame is too large");
      return;
    }
    if (!seat.budget) seat.budget = freshBudget(Date.now());
    const frame = takeFrame(seat.budget, Date.now());
    ws.serializeAttachment(seat);
    if (frame !== "ok") {
      ws.close(CLOSE_LIMIT, "Too many signalling messages");
      return;
    }

    const parsed = parseClientSignal(message);
    if (!parsed.ok && parsed.reason === "too-large") {
      ws.close(CLOSE_LIMIT, "Signalling frame is too large");
      return;
    }
    if (!parsed.ok || !signalRoleOk(seat.role, parsed.signal)) {
      this.markBad(ws, seat);
      return;
    }
    const other = this.live().find((row) => row.seat.cid !== seat.cid);
    if (!other) return;
    if (takeSignal(seat.budget, parsed.signal.type) !== "ok") {
      ws.serializeAttachment(seat);
      ws.close(CLOSE_LIMIT, "Too many signalling messages");
      return;
    }
    ws.serializeAttachment(seat);
    const summary = summarizeSignal(parsed.signal, parsed.bytes);
    this.send(other.ws, parsed.signal);
    await this.note(summary.kind, parsed.bytes, summary.summary, "batch");
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const seat = ws.deserializeAttachment() as Attachment | null;
    if (!seat || seat.silent) return;
    const meta = await this.loadMeta();
    if (!meta || isExpired(meta.expiresAt, Date.now())) return;
    const still = this.live().some((row) => row.seat.cid === seat.cid);
    if (still) return;
    await this.note("leave", 0, `leave · ${seat.role}`, "now");
    this.announce();
  }

  async webSocketError(): Promise<void> {
    this.announce();
  }

  private markBad(ws: WebSocket, seat: Attachment): void {
    seat.budget.bad += 1;
    ws.serializeAttachment(seat);
    if (seat.budget.bad >= MAX_BAD_FRAMES) ws.close(CLOSE_LIMIT, "Too many bad signalling frames");
  }

  private live(): Live[] {
    const out: Live[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const seat = ws.deserializeAttachment() as Attachment | null;
      if (!seat?.cid || seat.silent) continue;
      out.push({ ws, seat });
    }
    return out;
  }

  private announce(): void {
    const rows = this.live();
    const peers = rows.length;
    const ready = rows.some((row) => row.seat.role === "offerer") && rows.some((row) => row.seat.role === "answerer");
    for (const row of rows) this.send(row.ws, { type: "peer", peers, ready });
  }

  private async loadMeta(): Promise<Meta | null> {
    if (this.meta) return this.meta;
    this.meta = (await this.ctx.storage.get<Meta>("meta")) ?? null;
    return this.meta;
  }

  private nextEvent(meta: Meta, kind: TapeEvent["kind"], bytes: number, summary: string): TapeEvent {
    meta.seq += 1;
    return { n: meta.seq, at: Date.now(), kind, bytes, summary };
  }

  private async note(kind: TapeEvent["kind"], bytes: number, summary: string, mode: "now" | "batch"): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const meta = await this.loadMeta();
      if (!meta) return;
      const event = this.nextEvent(meta, kind, bytes, summary);
      meta.tape = [...meta.tape, event].slice(-TAPE_LIMIT);
      this.meta = meta;
      for (const row of this.live()) this.send(row.ws, { type: "tape", event });
      if (mode === "batch") {
        this.dirty += 1;
        const stale = Date.now() - this.lastFlushAt >= 1000;
        if (this.dirty < TAPE_BATCH && !stale) return;
      }
      await this.ctx.storage.put("meta", meta);
      this.dirty = 0;
      this.lastFlushAt = Date.now();
    });
  }

  private send(ws: WebSocket, payload: object): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(payload));
  }

  private reject(code: number, reason: string): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    server.close(code, reason);
    return new Response(null, { status: 101, webSocket: client });
  }
}

export type HelloMessage = {
  type: "hello";
  role: Role;
  cid: string;
  peers: number;
  expiresAt: number;
  tape: TapeEvent[];
  iceServers: IceServer[];
};
