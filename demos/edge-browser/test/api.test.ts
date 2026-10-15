import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { handleApi, HttpError } from "../src/worker/api";
import { insertCapture } from "../src/worker/db";

const OWNER = "a".repeat(32);
const OTHER = "b".repeat(32);
const CAPTURE = "c".repeat(32);

function memoryDb(): Database {
  const db = new Database(":memory:");
  for (const file of ["0001_init.sql", "0002_budget.sql", "0003_ip48.sql"]) {
    db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  }
  return db;
}

function asD1(db: Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = {
        args: [] as unknown[],
        bind(...args: unknown[]) {
          statement.args = args;
          return statement;
        },
        async run() {
          const info = db.query(sql).run(...(statement.args as never[]));
          return { success: true, meta: { changes: info.changes } };
        },
        async first<T>() {
          return (db.query(sql).get(...(statement.args as never[])) as T | null) ?? null;
        },
        async all<T>() {
          return { results: db.query(sql).all(...(statement.args as never[])) as T[] };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

function apiEnv(db: Database): Env {
  return {
    DB: asD1(db),
    ENVIRONMENT: "local",
    IP_HASH_SECRET: "test-ip-secret",
    TURNSTILE_SECRET: "secret",
    TURNSTILE_SITE_KEY: "site",
    AI_MODEL: "@cf/zai-org/glm-5.3-flash",
    READ_LIMIT: { limit: async () => ({ success: true }) },
    BUCKET: { get: async () => null, put: async () => undefined },
  } as unknown as Env;
}

describe("atomic budget insert", () => {
  test("the conditional insert stops at the cookie cap", async () => {
    const db = memoryDb();
    const env = apiEnv(db);
    for (let i = 0; i < 6; i++) {
      const ok = await insertCapture(env, {
        id: i.toString(16).padStart(32, "1"),
        visitorId: OWNER,
        ipKey: `k${i}`,
        ip48Key: `w${i}`,
        url: "https://example.com/",
        now: 1_000_000 + i,
      });
      expect(ok).toBe(true);
    }
    const blocked = await insertCapture(env, {
      id: "2".repeat(32),
      visitorId: OWNER,
      ipKey: "knew",
      ip48Key: "wnew",
      url: "https://example.com/",
      now: 1_000_100,
    });
    expect(blocked).toBe(false);
  });

  test("the conditional insert stops at the /48 cap", async () => {
    const db = memoryDb();
    const env = apiEnv(db);
    for (let i = 0; i < 20; i++) {
      const ok = await insertCapture(env, {
        id: i.toString(16).padStart(32, "3"),
        visitorId: i.toString(16).padStart(32, "4"),
        ipKey: `slash64-${i}`,
        ip48Key: "same-48",
        url: "https://example.com/",
        now: 2_000_000 + i,
      });
      expect(ok).toBe(true);
    }
    const blocked = await insertCapture(env, {
      id: "5".repeat(32),
      visitorId: "6".repeat(32),
      ipKey: "slash64-new",
      ip48Key: "same-48",
      url: "https://example.com/",
      now: 2_000_100,
    });
    expect(blocked).toBe(false);
  });
});

async function call(env: Env, path: string, cookie: string): Promise<Response> {
  try {
    return await handleApi(new Request(`http://127.0.0.1${path}`, { headers: { cookie: `eb_vid=${cookie}` } }), env, path);
  } catch (err) {
    if (err instanceof HttpError) {
      return Response.json({ error: { code: err.code, message: err.message } }, { status: err.status });
    }
    throw err;
  }
}

describe("foreign visitor", () => {
  test("a different visitor gets 404 for the capture and the file", async () => {
    const db = memoryDb();
    const env = apiEnv(db);
    const inserted = await insertCapture(env, {
      id: CAPTURE,
      visitorId: OWNER,
      ipKey: "k",
      ip48Key: "w",
      url: "https://example.com/",
      now: 3_000_000,
    });
    expect(inserted).toBe(true);
    db.query(`UPDATE captures SET status = 'complete' WHERE id = ?`).run(CAPTURE);

    const own = await call(env, `/api/captures/${CAPTURE}`, OWNER);
    expect(own.status).toBe(200);

    const foreign = await call(env, `/api/captures/${CAPTURE}`, OTHER);
    expect(foreign.status).toBe(404);
    const foreignBody = (await foreign.json()) as { error?: { message?: string } };
    expect(foreignBody.error?.message).toBe("That capture does not exist.");

    const file = await call(env, `/api/captures/${CAPTURE}/desktop`, OTHER);
    expect(file.status).toBe(404);
    const fileBody = (await file.json()) as { error?: { message?: string } };
    expect(fileBody.error?.message).toBe("That capture does not exist.");
  });
});
