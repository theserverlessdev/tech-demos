import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { durableSql } from "../../test/durable-sql";
import {
  DAILY_CAP,
  SEARCH_DAILY_CAP,
  TOKEN_TTL_MS,
  TOKEN_USE_LIMIT,
  claimSql,
  ensureCapSchema,
  nextMidnightUtc,
  refundSql,
  rememberSql,
  takeSql,
  type CapSql,
} from "./cap";

function sqlite(db: Database): CapSql {
  return durableSql(db);
}

function open(): CapSql {
  const sql = sqlite(new Database(":memory:"));
  ensureCapSchema(sql);
  return sql;
}

test("the ask counter stops at 200 and rolls to the next UTC day", () => {
  const sql = open();
  const now = new Date("2026-10-27T23:59:00.000Z");
  for (let i = 0; i < DAILY_CAP; i++) {
    const result = claimSql(sql, "asks", now, DAILY_CAP);
    expect(result.ok).toBe(true);
  }
  const blocked = claimSql(sql, "asks", now, DAILY_CAP);
  expect(blocked.ok).toBe(false);
  expect(blocked.used).toBe(200);
  expect(blocked.remaining).toBe(0);
  expect(blocked.resetsAt).toBe("2026-10-28T00:00:00.000Z");
  expect(nextMidnightUtc(now)).toBe("2026-10-28T00:00:00.000Z");
  const nextDay = claimSql(sql, "asks", new Date("2026-10-28T00:00:00.000Z"), DAILY_CAP);
  expect(nextDay.ok).toBe(true);
  expect(nextDay.used).toBe(1);
  expect(sql.exec("SELECT count AS n FROM asks WHERE day = ?", "2026-10-27").toArray()[0]).toEqual({ n: 200 });
});

test("the search counter stops at 1000 and a refund gives the slot back", () => {
  const sql = open();
  const now = new Date("2026-10-27T12:00:00.000Z");
  const first = claimSql(sql, "searches", now, SEARCH_DAILY_CAP);
  expect(first.used).toBe(1);
  refundSql(sql, "searches", now);
  expect(sql.exec("SELECT count AS n FROM searches WHERE day = ?", "2026-10-27").toArray()[0]).toEqual({ n: 0 });
  refundSql(sql, "searches", now);
  expect(sql.exec("SELECT count AS n FROM searches WHERE day = ?", "2026-10-27").toArray()[0]).toEqual({ n: 0 });
  for (let i = 0; i < SEARCH_DAILY_CAP; i++) claimSql(sql, "searches", now, SEARCH_DAILY_CAP);
  expect(claimSql(sql, "searches", now, SEARCH_DAILY_CAP).ok).toBe(false);
  const tomorrow = claimSql(sql, "searches", new Date("2026-10-28T00:00:00.000Z"), SEARCH_DAILY_CAP);
  expect(tomorrow.ok).toBe(true);
  expect(tomorrow.used).toBe(1);
});

test("a token is inserted once, expires on its own clock, and allows two uses", () => {
  const sql = open();
  const start = 1_700_000_000_000;
  expect(rememberSql(sql, "hash", start)).toBe(true);
  expect(rememberSql(sql, "hash", start + 50_000)).toBe(false);
  const saved = sql.exec("SELECT exp, uses FROM tokens WHERE hash = ?", "hash").toArray()[0] as { exp: number; uses: number };
  expect(saved.exp).toBe(start + TOKEN_TTL_MS);
  expect(saved.uses).toBe(1);
  expect(takeSql(sql, "hash", start + 1_000)).toBe("replay");
  expect(takeSql(sql, "hash", start + 1_000)).toBe("spent");
  const after = sql.exec("SELECT exp, uses FROM tokens WHERE hash = ?", "hash").toArray()[0] as { exp: number; uses: number };
  expect(after.exp).toBe(start + TOKEN_TTL_MS);
  expect(after.uses).toBe(2);

  expect(rememberSql(sql, "fresh", start)).toBe(true);
  expect(takeSql(sql, "fresh", start + TOKEN_TTL_MS)).toBe("spent");
  const expired = sql.exec("SELECT exp, uses FROM tokens WHERE hash = ?", "fresh").toArray()[0] as { exp: number; uses: number };
  expect(expired.exp).toBe(start + TOKEN_TTL_MS);
  expect(expired.uses).toBe(1);
  expect(takeSql(sql, "missing", start)).toBe("absent");
});

test("a new token insert drops rows that have already expired", () => {
  const sql = open();
  const start = 1_700_000_000_000;
  expect(rememberSql(sql, "expired", start)).toBe(true);
  expect(rememberSql(sql, "live", start + 1_000)).toBe(true);
  expect(rememberSql(sql, "fresh", start + TOKEN_TTL_MS)).toBe(true);
  const hashes = (sql.exec("SELECT hash FROM tokens ORDER BY hash").toArray() as { hash: string }[]).map((row) => row.hash);
  expect(hashes).toEqual(["fresh", "live"]);
  const live = sql.exec("SELECT exp FROM tokens WHERE hash = ?", "live").toArray()[0] as { exp: number };
  expect(live.exp).toBe(start + 1_000 + TOKEN_TTL_MS);
});

test("a primary-key insert counts the index, and RETURNING still reports the row", () => {
  const db = new Database(":memory:");
  const sql = durableSql(db);
  ensureCapSchema(sql);
  const inserted = sql.exec(
    "INSERT INTO tokens (hash, exp, uses) VALUES (?, ?, 1) ON CONFLICT(hash) DO NOTHING RETURNING hash",
    "hash",
    10,
  );
  expect(inserted.toArray()).toEqual([{ hash: "hash" }]);
  expect(inserted.rowsWritten).toBe(2);
  const replay = sql.exec(
    "UPDATE tokens SET uses = uses + 1 WHERE hash = ? AND uses < ? AND exp > ? RETURNING uses",
    "hash",
    TOKEN_USE_LIMIT,
    0,
  );
  expect(replay.toArray()).toEqual([{ uses: 2 }]);
  expect(replay.rowsWritten).toBe(1);
  const spent = sql.exec(
    "UPDATE tokens SET uses = uses + 1 WHERE hash = ? AND uses < ? AND exp > ? RETURNING uses",
    "hash",
    TOKEN_USE_LIMIT,
    0,
  );
  expect(spent.toArray()).toEqual([]);
  expect(spent.rowsWritten).toBe(0);
  expect(rememberSql(sql, "hash", 0)).toBe(false);
  expect(rememberSql(sql, "other", 0)).toBe(true);
});

test("remember reports the insert before the prune, so the second use succeeds", () => {
  const sql = open();
  const now = 1_700_000_000_000;
  expect(rememberSql(sql, "stale", now - TOKEN_TTL_MS)).toBe(true);
  expect(rememberSql(sql, "hash", now)).toBe(true);
  expect((sql.exec("SELECT hash FROM tokens ORDER BY hash").toArray() as { hash: string }[]).map((row) => row.hash)).toEqual(["hash"]);
  expect(takeSql(sql, "hash", now + 1)).toBe("replay");
  expect(takeSql(sql, "hash", now + 1)).toBe("spent");
});

test("an older token table gains a uses column without a new expiry", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE tokens (hash TEXT PRIMARY KEY, exp INTEGER NOT NULL)");
  db.query("INSERT INTO tokens (hash, exp) VALUES (?, ?)").run("kept", 42);
  const sql = sqlite(db);
  ensureCapSchema(sql);
  const row = sql.exec("SELECT exp, uses FROM tokens WHERE hash = ?", "kept").toArray()[0] as { exp: number; uses: number };
  expect(row.exp).toBe(42);
  expect(row.uses).toBe(1);
  expect(takeSql(sql, "kept", 0)).toBe("replay");
  expect(takeSql(sql, "kept", 0)).toBe("spent");
});
