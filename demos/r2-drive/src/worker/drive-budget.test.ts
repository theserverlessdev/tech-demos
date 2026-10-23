import { Database, type SQLQueryBindings } from "bun:sqlite";
import { expect, mock, test } from "bun:test";
import { MAX_DRIVE_REQUESTS } from "../shared/constants";
import { D1Repo } from "./repo";
import { BUDGET_EXHAUSTED_MESSAGE, setUnitsUsed, unitsUsed } from "./requests";
import { bunSql } from "./sqlite-bun";

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

const DRIVE_ID = "drv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

test("DriveObject.fetch charges the lifetime budget and logs when it is spent", async () => {
  const { DriveObject } = await import("./drive");
  const database = new Database(":memory:");
  const sql = bunSql(database);
  let ready: Promise<unknown> = Promise.resolve();
  const ctx = {
    id: { name: DRIVE_ID },
    storage: {
      sql,
      get: async () => undefined,
      put: async () => undefined,
      setAlarm: async () => undefined,
      deleteAll: async () => undefined,
    },
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => {
      ready = fn();
      return ready;
    },
    getWebSockets: () => [],
    acceptWebSocket: () => undefined,
  };
  const drive = new DriveObject(ctx as unknown as DurableObjectState, {} as never);
  await ready;
  setUnitsUsed(sql, MAX_DRIVE_REQUESTS - 1);
  const request = () =>
    new Request("http://127.0.0.1/not-dav", {
      headers: { "x-r2drive-authed": "1" },
    });
  const admitted = await drive.fetch(request());
  expect(admitted.status).toBe(403);
  expect(unitsUsed(sql)).toBe(MAX_DRIVE_REQUESTS);
  const lines: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args);
  };
  try {
    const denied = await drive.fetch(request());
    expect(denied.status).toBe(429);
    expect(await denied.text()).toBe(BUDGET_EXHAUSTED_MESSAGE);
  } finally {
    console.error = original;
  }
  expect(JSON.stringify(lines)).toContain("drive_budget_exhausted");
  expect(unitsUsed(sql)).toBe(MAX_DRIVE_REQUESTS);
});

test("D1Repo.freeze keeps the first frozen_at through COALESCE", async () => {
  const database = new Database(":memory:");
  database.exec(`CREATE TABLE drives (
    id TEXT PRIMARY KEY,
    email_hmac TEXT NOT NULL,
    email_enc TEXT NOT NULL,
    ip_hmac TEXT NOT NULL,
    network_hmac TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    wiped_at INTEGER,
    frozen_at INTEGER,
    status TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    session_hash TEXT,
    bytes_used INTEGER NOT NULL,
    file_count INTEGER NOT NULL,
    aup_version TEXT NOT NULL
  )`);
  database
    .query(
      `INSERT INTO drives (
        id, email_hmac, email_enc, ip_hmac, network_hmac, created_at, expires_at,
        status, password_hash, password_salt, bytes_used, file_count, aup_version
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active', ?8, ?9, 0, 0, ?10)`,
    )
    .run(DRIVE_ID, "hmac", "enc", "ip", "net", 1, 2, "hash", "salt", "2026-10-23.3");
  const repo = new D1Repo(d1FromSqlite(database));
  expect(await repo.freeze(DRIVE_ID, 1_000)).toBe(true);
  expect(await repo.freeze(DRIVE_ID, 9_000)).toBe(true);
  const row = await repo.getDrive(DRIVE_ID);
  expect(row?.status).toBe("frozen");
  expect(row?.frozenAt).toBe(1_000);
});

function d1FromSqlite(database: Database): D1Database {
  return {
    prepare(query: string) {
      const statement = database.query(query);
      let bound: SQLQueryBindings[] = [];
      const prepared = {
        bind(...values: SQLQueryBindings[]) {
          bound = values;
          return prepared;
        },
        async run() {
          const result = statement.run(...bound);
          return { meta: { changes: result.changes } };
        },
        async first<T>() {
          const row = statement.get(...bound) as T | null | undefined;
          return row ?? null;
        },
        async all<T>() {
          return { results: statement.all(...bound) as T[] };
        },
      };
      return prepared;
    },
  } as unknown as D1Database;
}
