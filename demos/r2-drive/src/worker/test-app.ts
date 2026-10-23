import { Database } from "bun:sqlite";
import { importAesKey, importHmacKey } from "./crypto";
import { MemoryLockStore } from "./locks";
import { MemoryBucket, PrefixBucket } from "./bucket";
import { DriveSession } from "./drive-session";
import { completeWipe, runAlarm, type WipeDecision } from "./drive-wipe";
import { chargeRequest, setUnitsUsed, unitsUsed as readUnits } from "./requests";
import { bunSql } from "./sqlite-bun";
import type { SqlRunner } from "./quota";
import { MemoryRepo } from "./repo";
import { handleRequest, wipeExpired, type Deps } from "./router";
import type { LimitName } from "../shared/constants";
import type { LogEvent } from "../shared/types";

export type TestApp = {
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  repo: MemoryRepo;
  bucket: MemoryBucket;
  emails: { to: string; subject: string; text: string }[];
  clock: { t: number };
  sweep: () => Promise<number>;
  alarm: (driveId: string) => Promise<WipeDecision>;
  setLimit: (fn: (name: LimitName, key: string) => Promise<boolean>) => void;
  unitsUsed: (driveId: string) => number;
  setUnitsUsed: (driveId: string, used: number) => void;
};

export async function createTestApp(options?: {
  mintEnabled?: boolean;
  now?: number;
  publicOrigin?: string;
  configured?: boolean;
}): Promise<TestApp> {
  const repo = new MemoryRepo();
  const bucket = new MemoryBucket();
  const emails: TestApp["emails"] = [];
  const events = new Map<string, LogEvent[]>();
  const clock = { t: options?.now ?? Date.parse("2026-10-23T12:00:00Z") };
  const runtimes = new Map<string, { session: DriveSession; locks: MemoryLockStore; database: Database; sql: SqlRunner }>();
  let limit: (name: LimitName, key: string) => Promise<boolean> = async () => true;
  const auditKey = await importAesKey(new Uint8Array(32).fill(7));
  const auditHmac = await importHmacKey(new Uint8Array(32).fill(9));
  const runtimeFor = (driveId: string) => {
    const existing = runtimes.get(driveId);
    if (existing) return existing;
    const database = new Database(":memory:");
    const sql = bunSql(database);
    const locks = new MemoryLockStore();
    const session = new DriveSession({
      sql,
      bucket: new PrefixBucket(bucket, `drives/${driveId}/`),
      locks,
      audit: async (info) => {
        await repo.addObject({
          driveId,
          key: `drives/${driveId}/${info.key}`,
          sha256: info.sha256,
          size: info.size,
          firstSeen: clock.t,
        });
      },
    });
    const runtime = { session, locks, database, sql };
    runtimes.set(driveId, runtime);
    return runtime;
  };
  const deps: Deps = {
    repo,
    bucket,
    locksFor: (driveId) => {
      const runtime = runtimeFor(driveId);
      return {
        list: (now) => runtime.locks.list(now),
        wipe: async () => {
          await runtime.session.seal();
          await runtime.locks.clear();
          runtime.database.exec("DELETE FROM quota");
          runtime.database.exec("INSERT INTO quota (id, bytes, files) VALUES (1, 0, 0)");
        },
      };
    },
    serveDav: async (request, drive, target) => {
      const runtime = runtimeFor(drive.id);
      const budget = chargeRequest(runtime.sql, drive.id);
      if (budget) return budget;
      const before = runtime.session.quota.snapshot();
      const response = await runtime.session.handle(request, target.mountPath, target.key, () => clock.t, drive.expiresAt);
      const after = runtime.session.quota.snapshot();
      if (before.bytes !== after.bytes || before.files !== after.files) {
        await repo.updateUsage(drive.id, after.bytes, after.files);
        drive.bytesUsed = after.bytes;
        drive.fileCount = after.files;
      }
      const list = events.get(drive.id) ?? [];
      list.push({ at: clock.t, method: request.method, path: target.key || "/", status: response.status });
      events.set(drive.id, list);
      return response;
    },
    limit: (name, key) => limit(name, key),
    verifyTurnstile: async (token) => token === "ok",
    sendEmail: async (message) => {
      emails.push(message);
    },
    now: () => clock.t,
    mintEnabledEnv: options?.mintEnabled !== false,
    adminToken: "admin-secret",
    auditKey: options?.configured === false ? null : auditKey,
    auditHmac: options?.configured === false ? null : auditHmac,
    mailFrom: "drive@example.com",
    publicOrigin: options?.publicOrigin ?? "http://127.0.0.1:8808",
    devOutbox: true,
    siteKey: "site-key",
    configured: options?.configured !== false,
    recent: (driveId) => events.get(driveId) ?? [],
    deferAlarm: async () => undefined,
  };
  const alarm = (driveId: string) => {
    const row = repo.drives.find((item) => item.id === driveId) ?? null;
    return runAlarm({
      row,
      now: clock.t,
      setAlarm: async () => undefined,
      wipe: async (now) => {
        const runtime = runtimes.get(driveId);
        if (runtime) await runtime.session.seal();
        await completeWipe({
          name: driveId,
          storedId: driveId,
          bucket,
          markWiped: (id, at) => repo.markWiped(id, at),
          deleteAll: async () => {
            await runtime?.locks.clear();
            runtime?.database.exec("DELETE FROM quota");
            runtime?.database.exec("INSERT INTO quota (id, bytes, files) VALUES (1, 0, 0)");
          },
          now,
        });
        runtimes.delete(driveId);
      },
    });
  };
  return {
    repo,
    bucket,
    emails,
    clock,
    fetch: (input, init) => {
      const request = new Request(input, init);
      return handleRequest(request, deps);
    },
    sweep: () => wipeExpired(deps),
    alarm,
    setLimit: (fn) => {
      limit = fn;
    },
    unitsUsed: (driveId) => readUnits(runtimeFor(driveId).sql),
    setUnitsUsed: (driveId, used) => setUnitsUsed(runtimeFor(driveId).sql, used),
  };
}

const ORIGIN = "http://127.0.0.1:8808";

export async function mintDrive(app: TestApp, email = "ada@example.com", ip = "203.0.113.10") {
  const headers = { "content-type": "application/json", "cf-connecting-ip": ip };
  const minted = await app.fetch(`${ORIGIN}/api/mint`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email, aup: true, turnstileToken: "ok" }),
  });
  const mintBody = (await minted.json()) as { error?: { code: string } };
  if (!minted.ok) throw new Error(`mint failed ${minted.status} ${mintBody.error?.code ?? ""}`);
  const outbox = await app.fetch(`${ORIGIN}/api/dev/outbox`);
  const token = ((await outbox.json()) as { token: string | null }).token;
  if (!token) throw new Error("missing dev token");
  const verified = await app.fetch(`${ORIGIN}/api/verify`, {
    method: "POST",
    headers,
    body: JSON.stringify({ token }),
  });
  const body = (await verified.json()) as {
    driveId: string;
    username: string;
    password: string;
    expiresAt: number;
    mountPath: string;
    error?: { code: string };
  };
  if (!verified.ok) throw new Error(`verify failed ${verified.status} ${body.error?.code ?? ""}`);
  const cookie = (verified.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { ...body, cookie, ip };
}

export function davUrl(driveId: string, key = ""): string {
  const suffix = key ? `/${key.split("/").map(encodeURIComponent).join("/")}` : "/";
  return `${ORIGIN}/dav/${driveId}${suffix}`;
}

export function authHeaders(drive: { driveId: string; password: string; cookie: string }, extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  if (drive.cookie) headers.set("cookie", drive.cookie);
  else headers.set("authorization", `Basic ${btoa(`${drive.driveId}:${drive.password}`)}`);
  return headers;
}
