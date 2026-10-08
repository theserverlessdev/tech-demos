import type { Connection, ConnectionContext } from "partyserver";
import { YServer } from "y-partyserver";
import * as Y from "yjs";
import {
  CLOSE_EXPIRED,
  CLOSE_FRAME,
  CLOSE_FULL,
  CLOSE_RATE,
  CLOSE_UNKNOWN,
  MAX_BYTES_PER_SEC,
  MAX_CONNECTIONS,
  MAX_DOC_BYTES,
  MAX_FRAME_BYTES,
  MAX_FRAMES_PER_SEC,
  MAX_STROKES,
  ROOM_TTL_MS,
  type RoomStatus,
} from "../shared/protocol";

type RoomMeta = {
  id: string;
  createdAt: number;
  expiresAt: number;
};

const INTERNAL = "x-party-internal";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(message: string | ArrayBuffer | ArrayBufferView): number {
  if (typeof message === "string") return new TextEncoder().encode(message).byteLength;
  if (message instanceof ArrayBuffer) return message.byteLength;
  return message.byteLength;
}

function connectionCount(room: { getConnections(tag?: string): Iterable<Connection> }): number {
  let count = 0;
  for (const _conn of room.getConnections()) count += 1;
  return count;
}

/**
 * Hibernating Yjs room. `Server.options` defaults hibernate to false and the
 * resolver stops at the first explicit value, so this class sets it itself.
 * Names and cursors stay on the awareness channel; only the stroke map is saved.
 */
export class BoardRoom extends YServer<Env> {
  static options = { hibernate: true };
  static callbackOptions = { debounceWait: 250, debounceMaxWait: 800, timeout: 5000 };

  #overCap = false;

  override async onStart(): Promise<void> {
    await super.onStart();
    this.#noteCap(false);
    this.document.on("update", () => {
      this.#noteCap(true);
    });
    await this.#ensureAlarm();
  }

  override async onLoad(): Promise<void> {
    if (await this.ctx.storage.get("dead")) return;
    const meta = await this.ctx.storage.get<RoomMeta>("meta");
    if (!meta || meta.expiresAt <= Date.now()) return;
    const stored = await this.ctx.storage.get<Uint8Array>("yjs");
    if (stored && stored.byteLength > 0) Y.applyUpdate(this.document, stored);
  }

  override async onSave(): Promise<void> {
    await this.#persist();
  }

  override isReadOnly(_connection: Connection): boolean {
    return this.#overCap;
  }

  override async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    const gate = await this.#gate();
    if (gate !== "open") {
      connection.close(gate === "expired" ? CLOSE_EXPIRED : CLOSE_UNKNOWN, gate === "expired" ? "room expired" : "unknown room");
      return;
    }
    // accept() already registered this socket, so the new peer is included.
    if (connectionCount(this) > MAX_CONNECTIONS) {
      connection.close(CLOSE_FULL, "room full");
      return;
    }
    await super.onConnect(connection, ctx);
  }

  override async onMessage(connection: Connection, message: string | ArrayBuffer | ArrayBufferView): Promise<void> {
    const size = byteLength(message);
    if (size > MAX_FRAME_BYTES) {
      connection.close(CLOSE_FRAME, "frame too large");
      return;
    }
    if (!this.#admit(connection, size)) {
      connection.close(CLOSE_RATE, "slow down");
      return;
    }
    await super.onMessage(connection, message);
  }

  override async onClose(connection: Connection, code: number, reason: string, wasClean: boolean): Promise<void> {
    await super.onClose(connection, code, reason, wasClean);
    await this.#persist();
  }

  override async onAlarm(): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      const existing = await txn.list();
      for (const key of existing.keys()) await txn.delete(key);
      await txn.put("dead", true);
    });
    for (const connection of this.getConnections()) {
      try {
        connection.close(CLOSE_EXPIRED, "room expired");
      } catch {
        /* already closing */
      }
    }
  }

  override async onRequest(request: Request): Promise<Response> {
    if (request.headers.get(INTERNAL) !== "1") return new Response("Not found", { status: 404 });
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname.endsWith("/init")) return this.#init();
    if (request.method === "GET" && url.pathname.endsWith("/status")) return Response.json(await this.#status());
    return new Response("Not found", { status: 404 });
  }

  async #init(): Promise<Response> {
    if (await this.ctx.storage.get("dead")) {
      return Response.json({ error: { code: "expired", message: "That room has expired." } }, { status: 410 });
    }
    const existing = await this.ctx.storage.get<RoomMeta>("meta");
    if (existing && existing.expiresAt > Date.now()) {
      const alarmAt = await this.ctx.storage.getAlarm();
      return Response.json({ id: existing.id, expiresAt: existing.expiresAt, alarmAt });
    }
    const now = Date.now();
    const ttl = positiveInt(this.env.ROOM_TTL_MS, ROOM_TTL_MS);
    const meta: RoomMeta = { id: this.name, createdAt: now, expiresAt: now + ttl };
    await this.ctx.storage.put("meta", meta);
    await this.ctx.storage.setAlarm(meta.expiresAt);
    const alarmAt = await this.ctx.storage.getAlarm();
    return Response.json({ id: meta.id, expiresAt: meta.expiresAt, alarmAt }, { status: 201 });
  }

  async #status(): Promise<RoomStatus> {
    const dead = Boolean(await this.ctx.storage.get("dead"));
    const meta = await this.ctx.storage.get<RoomMeta>("meta");
    const expired = dead || !meta || meta.expiresAt <= Date.now();
    const stored = await this.ctx.storage.get<Uint8Array>("yjs");
    const alarmAt = await this.ctx.storage.getAlarm();
    return {
      id: meta?.id ?? this.name,
      createdAt: meta?.createdAt ?? 0,
      expiresAt: meta?.expiresAt ?? 0,
      alarmAt,
      connections: connectionCount(this),
      strokes: expired ? 0 : this.document.getMap("strokes").size,
      docBytes: stored?.byteLength ?? 0,
      full: this.#overCap,
      expired,
    };
  }

  async #gate(): Promise<"open" | "expired" | "unknown"> {
    if (await this.ctx.storage.get("dead")) return "expired";
    const meta = await this.ctx.storage.get<RoomMeta>("meta");
    if (!meta) return "unknown";
    if (meta.expiresAt <= Date.now()) return "expired";
    return "open";
  }

  async #ensureAlarm(): Promise<void> {
    const meta = await this.ctx.storage.get<RoomMeta>("meta");
    if (!meta || meta.expiresAt <= Date.now()) return;
    const alarmAt = await this.ctx.storage.getAlarm();
    if (alarmAt !== meta.expiresAt) await this.ctx.storage.setAlarm(meta.expiresAt);
  }

  async #persist(): Promise<void> {
    const bytes = Y.encodeStateAsUpdate(this.document);
    const tooBig = bytes.byteLength > MAX_DOC_BYTES;
    await this.ctx.storage.transaction(async (txn) => {
      if (await txn.get("dead")) return;
      const meta = await txn.get<RoomMeta>("meta");
      if (!meta || meta.expiresAt <= Date.now()) return;
      if (tooBig) return;
      await txn.put("yjs", bytes);
    });
    if (tooBig) this.#raiseCap();
  }

  #noteCap(announce: boolean): void {
    const strokes = this.document.getMap("strokes").size;
    if (strokes >= MAX_STROKES) this.#raiseCap();
    else if (announce && strokes > 0 && strokes % 20 === 0 && Y.encodeStateAsUpdate(this.document).byteLength > MAX_DOC_BYTES) this.#raiseCap();
  }

  #raiseCap(): void {
    if (this.#overCap) return;
    this.#overCap = true;
    this.broadcastCustomMessage(JSON.stringify({ type: "cap" }));
  }

  /** Sliding one-second meter on the hibernation attachment, merged with Yjs awareness ids. */
  #admit(connection: Connection, nbytes: number): boolean {
    const now = Date.now();
    let allowed = false;
    try {
      connection.setState((prev: unknown) => {
        const prior = isRecord(prev) ? prev : {};
        let started = typeof prior.t === "number" ? prior.t : now;
        let frames = typeof prior.frames === "number" ? prior.frames : 0;
        let bytes = typeof prior.bytes === "number" ? prior.bytes : 0;
        if (now - started >= 1000) {
          started = now;
          frames = 0;
          bytes = 0;
        }
        frames += 1;
        bytes += nbytes;
        allowed = frames <= MAX_FRAMES_PER_SEC && bytes <= MAX_BYTES_PER_SEC;
        return { ...prior, t: started, frames, bytes };
      });
    } catch {
      return false;
    }
    return allowed;
  }
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 60_000 || parsed > 24 * 60 * 60 * 1000) return fallback;
  return parsed;
}

export const internalHeader = INTERNAL;
