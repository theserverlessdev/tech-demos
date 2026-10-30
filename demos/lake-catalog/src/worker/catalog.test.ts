import { Database } from "bun:sqlite";
import { expect, mock, test } from "bun:test";
import { durableSql } from "../../test/sql";
import type { Env } from "./env";
import type { SqlExec } from "../shared/sql";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

type LakeCall = { op: "get" | "put"; key: string };

function recordingLake() {
  const calls: LakeCall[] = [];
  const objects = new Map<string, Uint8Array>();
  return {
    calls,
    objects,
    lake: {
      async get(key: string) {
        calls.push({ op: "get", key });
        const hit = objects.get(key);
        if (!hit) return null;
        return { arrayBuffer: async () => hit.buffer.slice(hit.byteOffset, hit.byteOffset + hit.byteLength) as ArrayBuffer };
      },
      async put(key: string, value: Uint8Array) {
        calls.push({ op: "put", key });
        objects.set(key, value);
      },
    },
  };
}

function recordingSql(db: Database): { sql: SqlExec; statements: string[] } {
  const inner = durableSql(db);
  const statements: string[] = [];
  return {
    statements,
    sql: {
      exec(query: string, ...bindings: unknown[]) {
        statements.push(query);
        return inner.exec(query, ...bindings);
      },
    },
  };
}

function writes(statements: string[]): string[] {
  return statements.filter((statement) => /^\s*(delete|insert)\b/i.test(statement));
}

async function catalogClass() {
  return (await import("./catalog")).QuackCatalog;
}

test("/api/map and /query do not put to R2 or rewrite SQLite once the catalog is seeded", async () => {
  const QuackCatalog = await catalogClass();
  const { depsFromEnv } = await import("./index");
  const { handleRequest } = await import("./http");
  const db = new Database(":memory:");
  const recorded = recordingSql(db);
  const bucket = recordingLake();
  let woken = false;
  const env = {
    DEV: "1",
    TURNSTILE_SITE_KEY: "0x4AAAAAAFRUoj5qDpf7XyIW",
    LAKE_BUCKET: "tech-demos-lake-catalog",
    TOKEN_TTL_SECONDS: "600",
    LAKE: bucket.lake,
    CATALOG_REGISTRY: {
      idFromName: () => ({ toString: () => "registry-demo" }),
      get: () => ({
        fetch() {
          woken = true;
          throw new Error("woke registry");
        },
      }),
    },
    CATALOGS: {
      idFromName: (name: string) => ({ toString: () => `${name}-do` }),
      get: () => ({
        fetch() {
          woken = true;
          throw new Error("woke catalog");
        },
      }),
    },
    QUERY_LIMIT: { limit: async () => ({ success: true }) },
    TOKEN_LIMIT: { limit: async () => ({ success: true }) },
    READ_LIMIT: { limit: async () => ({ success: true }) },
  };
  const catalog = new QuackCatalog({ storage: { sql: recorded.sql } } as unknown as DurableObjectState, { LAKE: bucket.lake } as Env);
  const seeded = await catalog.fetch(new Request("https://catalog/reset?catalog=orders", { method: "POST" }));
  expect(seeded.status).toBe(200);
  expect(bucket.calls.some((call) => call.op === "put")).toBe(true);
  bucket.calls.length = 0;
  recorded.statements.length = 0;

  const deps = depsFromEnv(env as unknown as Env);
  const map = await handleRequest(new Request("http://127.0.0.1/api/map"), deps, "/api/map");
  expect(map?.status).toBe(200);
  const listed = (await map?.json()) as { catalogs: { durableObjectId: string; rows: number; parquetNote: string }[] };
  expect(listed.catalogs.map((item) => item.durableObjectId)).toEqual(["orders-do", "regions-do"]);
  expect(listed.catalogs.map((item) => item.rows)).toEqual([10, 4]);
  expect(listed.catalogs.every((item) => item.parquetNote === "pending first nightly build")).toBe(true);
  expect(woken).toBe(false);

  const status = await catalog.fetch(new Request("https://catalog/status?catalog=orders"));
  expect(status.status).toBe(200);
  expect(((await status.json()) as { rows: number }).rows).toBe(10);
  const queried = await catalog.fetch(
    new Request("https://catalog/query?catalog=orders", {
      method: "POST",
      body: JSON.stringify({ role: "analyst", sql: "SELECT region FROM orders" }),
    }),
  );
  expect(queried.status).toBe(200);
  const result = (await queried.json()) as { rows: unknown[][] };
  expect(result.rows.length).toBe(10);
  expect(bucket.calls.filter((call) => call.op === "put")).toEqual([]);
  expect(writes(recorded.statements)).toEqual([]);
});

test("an empty catalog query may read R2 and does not write it", async () => {
  const QuackCatalog = await catalogClass();
  const db = new Database(":memory:");
  const recorded = recordingSql(db);
  const bucket = recordingLake();
  const catalog = new QuackCatalog({ storage: { sql: recorded.sql } } as unknown as DurableObjectState, { LAKE: bucket.lake } as Env);
  const status = await catalog.fetch(new Request("https://catalog/status?catalog=orders"));
  expect(((await status.json()) as { rows: number }).rows).toBe(0);
  expect(bucket.calls).toEqual([]);
  expect(writes(recorded.statements)).toEqual([]);
  const queried = await catalog.fetch(
    new Request("https://catalog/query?catalog=orders", {
      method: "POST",
      body: JSON.stringify({ role: "viewer", sql: "SELECT region FROM orders" }),
    }),
  );
  expect(queried.status).toBe(200);
  expect(bucket.calls.filter((call) => call.op === "put")).toEqual([]);
  expect(bucket.calls.some((call) => call.op === "get")).toBe(true);
  expect(writes(recorded.statements).length).toBeGreaterThan(0);
  bucket.calls.length = 0;
  recorded.statements.length = 0;
  await catalog.fetch(
    new Request("https://catalog/query?catalog=orders", {
      method: "POST",
      body: JSON.stringify({ role: "viewer", sql: "SELECT region FROM orders" }),
    }),
  );
  expect(bucket.calls.filter((call) => call.op === "put")).toEqual([]);
  expect(writes(recorded.statements)).toEqual([]);
});
