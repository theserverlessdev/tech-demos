import { importAesKey, importHmacKey } from "./crypto";
import { MemoryLockStore, type LockStore } from "./locks";
import { MemoryBucket } from "./bucket";
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
  setLimit: (fn: (name: LimitName, key: string) => Promise<boolean>) => void;
};

export async function createTestApp(options?: { mintEnabled?: boolean; now?: number; publicOrigin?: string }): Promise<TestApp> {
  const repo = new MemoryRepo();
  const bucket = new MemoryBucket();
  const locks = new Map<string, LockStore>();
  const emails: TestApp["emails"] = [];
  const events = new Map<string, LogEvent[]>();
  const clock = { t: options?.now ?? Date.parse("2026-10-23T12:00:00Z") };
  let limit: (name: LimitName, key: string) => Promise<boolean> = async () => true;
  const auditKey = await importAesKey(new Uint8Array(32).fill(7));
  const auditHmac = await importHmacKey(new Uint8Array(32).fill(9));
  const deps: Deps = {
    repo,
    bucket,
    locksFor: (driveId) => {
      const existing = locks.get(driveId);
      if (existing) return existing;
      const store = new MemoryLockStore();
      locks.set(driveId, store);
      return store;
    },
    limit: (name, key) => limit(name, key),
    verifyTurnstile: async (token) => token === "ok",
    sendEmail: async (message) => {
      emails.push(message);
    },
    now: () => clock.t,
    mintEnabledEnv: options?.mintEnabled !== false,
    adminToken: "admin-secret",
    auditKey,
    auditHmac,
    mailFrom: "drive@example.com",
    publicOrigin: options?.publicOrigin ?? "http://127.0.0.1:8808",
    devOutbox: true,
    siteKey: "site-key",
    configured: true,
    recent: (driveId) => events.get(driveId) ?? [],
    note: (driveId, event) => {
      const list = events.get(driveId) ?? [];
      list.push(event);
      events.set(driveId, list);
    },
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
    setLimit: (fn) => {
      limit = fn;
    },
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
