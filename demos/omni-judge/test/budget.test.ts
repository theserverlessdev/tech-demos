import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { LIMITS } from "../src/shared/limits";
import { insertJudgment } from "../src/worker/db";
import { budgetDecision, hashIpKey, networkKey } from "../src/worker/policy";

function memoryDb(): Database {
  const db = new Database(":memory:");
  db.exec(readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
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

function row(i: number, visitor: string, ipKey: string, now: number) {
  return {
    id: i.toString(16).padStart(32, "a"),
    visitorId: visitor,
    mediaId: null,
    sampleId: "package",
    kind: "omni" as const,
    modality: "image" as const,
    label: "Package still",
    ipKey,
    questionsJson: "[]",
    now,
  };
}

describe("atomic budget insert", () => {
  test("the conditional insert stops at the visitor cap", async () => {
    const env = { DB: asD1(memoryDb()) } as Env;
    const now = 1_700_000_000_000;
    for (let i = 0; i < LIMITS.perVisitorHour; i++) {
      expect(await insertJudgment(env, row(i, "visitor", `ip-${i}`, now + i))).toBe(true);
    }
    expect(await insertJudgment(env, row(90, "visitor", "ip-new", now + 90))).toBe(false);
  });

  test("the conditional insert stops at the network cap", async () => {
    const env = { DB: asD1(memoryDb()) } as Env;
    const now = 1_700_000_000_000;
    for (let i = 0; i < LIMITS.perNetworkHour; i++) {
      expect(await insertJudgment(env, row(i + 100, `visitor-${i}`, "same-network", now + i))).toBe(true);
    }
    expect(await insertJudgment(env, row(190, "someone-else", "same-network", now + 90))).toBe(false);
  });

  test("the conditional insert stops at the daily cap", async () => {
    const env = { DB: asD1(memoryDb()) } as Env;
    const now = 1_700_000_000_000;
    for (let i = 0; i < LIMITS.dailyCap; i++) {
      expect(await insertJudgment(env, row(i + 200, `v-${i}`, `n-${i}`, now + i))).toBe(true);
    }
    expect(await insertJudgment(env, row(400, "fresh", "fresh-net", now + 400))).toBe(false);
    expect(budgetDecision({ visitor: 0, network: 0, daily: LIMITS.dailyCap }).ok).toBe(false);
  });
});

describe("network hmac", () => {
  test("IPv6 /64 addresses share a key and the address is not stored", async () => {
    expect(networkKey("2001:db8:1:2::1")).toBe(networkKey("2001:db8:1:2:9::1"));
    expect(networkKey("2001:db8:1:3::1")).not.toBe(networkKey("2001:db8:1:2::1"));
    expect(networkKey("203.0.113.4")).toBe("203.0.113.4");
    const hash = await hashIpKey("2001:db8:1:2::1", "test-secret");
    expect(hash).toBe(await hashIpKey("2001:db8:1:2:abcd::9", "test-secret"));
    expect(hash).not.toBe(await hashIpKey("2001:db8:1:3::1", "test-secret"));
    expect(hash.includes("2001")).toBe(false);
    expect(hash).toHaveLength(64);
  });
});
