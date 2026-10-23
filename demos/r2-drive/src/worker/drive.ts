import { DurableObject } from "cloudflare:workers";
import { D1Repo } from "./repo";
import { adaptR2, PrefixBucket } from "./bucket";
import { DriveSession } from "./drive-session";
import { completeWipe, runAlarm } from "./drive-wipe";
import { SqliteLocks } from "./locks";
import { takeRequest } from "./requests";
import { closeClientSocket, closeLiveSockets, rejectClientMessage, socketLimitResponse } from "./sockets";
import { splitDavPath } from "../shared/paths";
import type { LockRecord } from "./locks";
import type { LogEvent, PublicLock } from "../shared/types";

type DriveEnv = {
  BUCKET: R2Bucket;
  DB: D1Database;
};

export class DriveObject extends DurableObject<DriveEnv> {
  private session: DriveSession | null = null;

  constructor(ctx: DurableObjectState, env: DriveEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      new SqliteLocks(this.ctx.storage.sql);
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS quota (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        bytes INTEGER NOT NULL,
        files INTEGER NOT NULL
      )`);
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        status INTEGER NOT NULL
      )`);
    });
  }

  async schedule(expiresAt: number): Promise<void> {
    const name = this.ctx.id.name;
    if (!name) console.error(JSON.stringify({ event: "schedule_missing_name" }));
    else await this.ctx.storage.put("driveId", name);
    await this.ctx.storage.put("expiresAt", expiresAt);
    await this.ctx.storage.setAlarm(expiresAt);
  }

  async deferAlarm(until: number): Promise<void> {
    await this.ctx.storage.setAlarm(until);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const storedId = await this.ctx.storage.get<string>("driveId");
    const id = this.ctx.id.name || storedId || "";
    if (!id) {
      console.error(JSON.stringify({ event: "alarm_missing_name", storedId: storedId ?? null }));
      return;
    }
    const row = await new D1Repo(this.env.DB).getDrive(id);
    await runAlarm({
      row,
      now,
      setAlarm: (at) => this.ctx.storage.setAlarm(at),
      wipe: (at) => this.wipe(at),
    });
  }

  async wipe(now: number): Promise<void> {
    if (this.session) await this.session.seal();
    const storedId = await this.ctx.storage.get<string>("driveId");
    const wiped = await completeWipe({
      name: this.ctx.id.name,
      storedId: storedId ?? undefined,
      bucket: adaptR2(this.env.BUCKET),
      markWiped: (id, at) => new D1Repo(this.env.DB).markWiped(id, at),
      deleteAll: () => this.ctx.storage.deleteAll(),
      now,
    });
    this.session = null;
    if (wiped) {
      this.broadcast({ type: "wiped" });
      closeLiveSockets(this.ctx.getWebSockets());
    }
  }

  webSocketMessage(ws: WebSocket): void {
    rejectClientMessage(ws);
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    closeClientSocket(ws, code, reason);
  }

  webSocketError(): void {}

  async listLocks(): Promise<LockRecord[]> {
    return new SqliteLocks(this.ctx.storage.sql).list(Date.now());
  }

  async recentEvents(): Promise<LogEvent[]> {
    return this.ctx.storage.sql
      .exec<EventRow>("SELECT at, method, path, status FROM events ORDER BY id DESC LIMIT 50")
      .toArray()
      .reverse()
      .map((row) => ({ at: row.at, method: row.method, path: row.path, status: row.status }));
  }

  async fetch(request: Request): Promise<Response> {
    const storedId = await this.ctx.storage.get<string>("driveId");
    const name = this.ctx.id.name || storedId || "";
    if (!this.ctx.id.name) console.error(JSON.stringify({ event: "drive_missing_name", storedId: storedId ?? null }));
    if (request.headers.get("x-r2drive-authed") !== "1" || !name) return new Response("Forbidden", { status: 403 });
    if (!takeRequest(this.ctx.storage.sql)) return new Response("Too many requests", { status: 429 });
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const limited = socketLimitResponse(this.ctx.getWebSockets().length);
      if (limited) return limited;
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].send(JSON.stringify({ type: "hello", locks: this.publicLocks(await this.listLocks()), events: await this.recentEvents() }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    const target = splitDavPath(new URL(request.url).pathname);
    if (target === null || target === "bad" || target.driveId !== name) return new Response("Forbidden", { status: 403 });
    const expiresAt = (await this.ctx.storage.get<number>("expiresAt")) ?? null;
    const session = this.driveSession(name);
    const before = session.quota.snapshot();
    const response = await session.handle(request, target.mountPath, target.key, () => Date.now(), expiresAt);
    const after = session.quota.snapshot();
    if (before.bytes !== after.bytes || before.files !== after.files) {
      await new D1Repo(this.env.DB).updateUsage(name, after.bytes, after.files);
    }
    this.ctx.storage.sql.exec("INSERT INTO events (at, method, path, status) VALUES (?, ?, ?, ?)", Date.now(), request.method, target.key || "/", response.status);
    this.ctx.storage.sql.exec("DELETE FROM events WHERE id <= (SELECT COALESCE(MAX(id), 0) FROM events) - 50");
    this.broadcast({ type: "event", event: { at: Date.now(), method: request.method, path: target.key || "/", status: response.status }, locks: this.publicLocks(await this.listLocks()) });
    return response;
  }

  private driveSession(name: string): DriveSession {
    if (this.session) return this.session;
    this.session = new DriveSession({
      sql: this.ctx.storage.sql,
      bucket: new PrefixBucket(adaptR2(this.env.BUCKET), `drives/${name}/`),
      locks: new SqliteLocks(this.ctx.storage.sql),
      audit: async (info) => {
        await new D1Repo(this.env.DB).addObject({
          driveId: name,
          key: `drives/${name}/${info.key}`,
          sha256: info.sha256,
          size: info.size,
          firstSeen: Date.now(),
        });
      },
    });
    return this.session;
  }

  private publicLocks(locks: LockRecord[]): PublicLock[] {
    return locks.map((lock) => ({
      path: lock.path,
      owner: lock.owner ?? null,
      scope: lock.scope,
      depth: lock.depth,
      timeout: lock.timeout,
      expiresAt: lock.expiresAt,
    }));
  }

  private broadcast(message: unknown): void {
    const text = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(text);
      } catch {
        // The socket closed between the list and the send.
      }
    }
  }
}

type EventRow = { at: number; method: string; path: string; status: number };
