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
  parseStroke,
  type RoomStatus,
} from "../shared/protocol";

type RoomMeta = {
  id: string;
  createdAt: number;
  expiresAt: number;
};

const INTERNAL = "x-party-internal";
const GUARD = "partyserver-guard";

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
    this.document.on("afterTransaction", (tr) => {
      if (tr.origin === GUARD) return;
      this.#enforce(tr);
    });
    this.#enforce(null);
    await this.#ensureAlarm();
  }

  override async onLoad(): Promise<void> {
    const meta = await this.ctx.storage.get<RoomMeta>("meta");
    if (!meta) {
      await this.ctx.storage.deleteAll();
      return;
    }
    if (meta.expiresAt <= Date.now()) return;
    const stored = await this.ctx.storage.get<Uint8Array>("yjs");
    if (stored && stored.byteLength > 0) Y.applyUpdate(this.document, stored);
  }

  override async onSave(): Promise<void> {
    await this.#persist();
  }

  override isReadOnly(_connection: Connection): boolean {
    return false;
  }

  override async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    if (!(await this.#admitSocket(connection))) return;
    await super.onConnect(connection, ctx);
    if (this.#overCap) this.sendCustomMessage(connection, JSON.stringify({ type: "cap" }));
  }

  override async onMessage(connection: Connection, message: string | ArrayBuffer | ArrayBufferView): Promise<void> {
    if (!isRecord(connection.state) || connection.state.ok !== true) return;
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
    await this.ctx.storage.deleteAll();
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
    const existing = await this.ctx.storage.get<RoomMeta>("meta");
    if (existing && existing.expiresAt > Date.now()) {
      const alarmAt = await this.ctx.storage.getAlarm();
      return Response.json({ id: existing.id, expiresAt: existing.expiresAt, alarmAt });
    }
    if (existing) await this.ctx.storage.deleteAll();
    const now = Date.now();
    const ttl = positiveInt(this.env.ROOM_TTL_MS, ROOM_TTL_MS);
    const meta: RoomMeta = { id: this.name, createdAt: now, expiresAt: now + ttl };
    await this.ctx.storage.put("meta", meta);
    await this.ctx.storage.setAlarm(meta.expiresAt);
    const alarmAt = await this.ctx.storage.getAlarm();
    return Response.json({ id: meta.id, expiresAt: meta.expiresAt, alarmAt }, { status: 201 });
  }

  async #status(): Promise<RoomStatus> {
    const meta = await this.ctx.storage.get<RoomMeta>("meta");
    if (!meta) {
      await this.ctx.storage.deleteAll();
      return {
        id: this.name,
        createdAt: 0,
        expiresAt: 0,
        alarmAt: null,
        connections: connectionCount(this),
        strokes: 0,
        docBytes: 0,
        full: false,
        expired: true,
      };
    }
    const expired = meta.expiresAt <= Date.now();
    const stored = await this.ctx.storage.get<Uint8Array>("yjs");
    const alarmAt = await this.ctx.storage.getAlarm();
    return {
      id: meta.id,
      createdAt: meta.createdAt,
      expiresAt: meta.expiresAt,
      alarmAt,
      connections: connectionCount(this),
      strokes: expired ? 0 : (strokeMap(this.document)?.size ?? 0),
      docBytes: stored?.byteLength ?? 0,
      full: this.#overCap,
      expired,
    };
  }

  async #gate(): Promise<"open" | "expired" | "unknown"> {
    const meta = await this.ctx.storage.get<RoomMeta>("meta");
    if (!meta) {
      await this.ctx.storage.deleteAll();
      return "unknown";
    }
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
      const meta = await txn.get<RoomMeta>("meta");
      if (!meta || meta.expiresAt <= Date.now()) return;
      if (tooBig) return;
      await txn.put("yjs", bytes);
    });
    if (tooBig) this.#syncCap(bytes.byteLength);
  }

  /**
   * Drop invalid / over-budget ink inside a GUARD transaction so y-partyserver
   * still broadcasts the deletes. Caps stay hard, and erasing reopens the board.
   */
  #enforce(tr: Y.Transaction | null): void {
    const doc = this.document;
    let trimmed = false;
    let bytes = 0;
    doc.transact(() => {
      for (const name of [...doc.share.keys()]) {
        if (name === "strokes") continue;
        purgeForeign(doc, name);
      }
      const strokes = strokeMap(doc);
      if (!strokes) {
        bytes = Y.encodeStateAsUpdate(doc).byteLength;
        return;
      }
      const added: string[] = [];
      if (tr) {
        for (const keys of tr.changed.values()) {
          for (const key of keys) {
            if (typeof key === "string" && strokes.has(key)) added.push(key);
          }
        }
        for (const key of added) {
          const parsed = parseStroke(strokes.get(key));
          if (!parsed || parsed.id !== key) {
            strokes.delete(key);
            trimmed = true;
          }
        }
      } else {
        for (const key of [...strokes.keys()]) {
          const parsed = parseStroke(strokes.get(key));
          if (!parsed || parsed.id !== key) strokes.delete(key);
        }
      }
      while (strokes.size > MAX_STROKES) {
        const victim = added.pop() ?? [...strokes.keys()].pop();
        if (!victim) break;
        strokes.delete(victim);
        trimmed = true;
      }
      bytes = Y.encodeStateAsUpdate(doc).byteLength;
      if (bytes > MAX_DOC_BYTES) {
        const byteVictims = [...added];
        while (bytes > MAX_DOC_BYTES) {
          const victim = byteVictims.pop() ?? [...strokes.keys()].pop();
          if (!victim) break;
          strokes.delete(victim);
          trimmed = true;
          bytes = Y.encodeStateAsUpdate(doc).byteLength;
        }
      }
    }, GUARD);
    this.#syncCap(bytes);
    if (trimmed && tr && isConnection(tr.origin)) {
      this.sendCustomMessage(tr.origin, JSON.stringify({ type: "cap" }));
    }
  }

  #syncCap(docBytes: number): void {
    const strokes = strokeMap(this.document)?.size ?? 0;
    const next = strokes >= MAX_STROKES || docBytes > MAX_DOC_BYTES;
    if (next === this.#overCap) return;
    this.#overCap = next;
    this.broadcastCustomMessage(JSON.stringify({ type: next ? "cap" : "open" }));
  }

  async #admitSocket(connection: Connection): Promise<boolean> {
    const prior = connection.state;
    if (isRecord(prior) && prior.ok === true) return true;
    const reject = (code: number, reason: string): false => {
      try {
        connection.setState((prev: unknown) => ({ ...(isRecord(prev) ? prev : {}), ok: false }));
      } catch {
        /* attachment may already be closing */
      }
      connection.close(code, reason);
      return false;
    };
    const gate = await this.#gate();
    if (gate !== "open") {
      return reject(gate === "expired" ? CLOSE_EXPIRED : CLOSE_UNKNOWN, gate === "expired" ? "room expired" : "unknown room");
    }
    if (connectionCount(this) > MAX_CONNECTIONS) return reject(CLOSE_FULL, "room full");
    try {
      connection.setState((prev: unknown) => ({ ...(isRecord(prev) ? prev : {}), ok: true }));
    } catch {
      return false;
    }
    return true;
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

/**
 * Updates restore unknown roots as AbstractType. `getText` / `getMap` on this
 * document upgrades them to the constructor that belongs to the same yjs copy
 * as the Durable Object (instanceof across copies is unreliable).
 */
function typeName(doc: Y.Doc, name: string): string {
  const raw = doc.share.get(name) as { constructor?: { name?: string } } | undefined;
  return raw?.constructor?.name ?? "";
}

type ShareRoot = { constructor?: { name?: string }; _start?: unknown };

function isListRoot(raw: ShareRoot | undefined): boolean {
  if (!raw) return false;
  const ctor = raw.constructor?.name ?? "";
  return ctor === "YArray" || ctor === "YText" || raw._start != null;
}

/** Map of ink, or null when the root is missing or was created as an Array/Text and emptied. */
function strokeMap(doc: Y.Doc): Y.Map<string> | null {
  const raw = doc.share.get("strokes") as ShareRoot | undefined;
  if (!raw) return null;
  if (isListRoot(raw)) {
    purgeForeign(doc, "strokes");
    return null;
  }
  return doc.getMap<string>("strokes");
}

function purgeForeign(doc: Y.Doc, name: string): void {
  const ctor = typeName(doc, name);
  if (ctor === "YMap") {
    const map = doc.getMap(name);
    for (const key of [...map.keys()]) map.delete(key);
    return;
  }
  try {
    const arr = doc.getArray(name);
    if (arr.length > 0) arr.delete(0, arr.length);
    return;
  } catch {
    /* defined as text */
  }
  try {
    const text = doc.getText(name);
    if (text.length > 0) text.delete(0, text.length);
  } catch {
    /* defined as a different constructor */
  }
}

function isConnection(value: unknown): value is Connection {
  return typeof value === "object" && value !== null && typeof (value as { send?: unknown }).send === "function";
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 60_000 || parsed > 24 * 60 * 60 * 1000) return fallback;
  return parsed;
}

export const internalHeader = INTERNAL;
