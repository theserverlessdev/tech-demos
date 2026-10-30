import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  claimSql,
  ensureCapSchema,
  forgetRoomSql,
  nextMidnightUtc,
  rememberRoomSql,
  refundSql,
  roomKnownSql,
  type CapSql,
} from "./cap";
import { DAILY_CAP } from "./protocol";

function open(): CapSql {
  const db = new Database(":memory:");
  const sql: CapSql = {
    exec(query: string, ...bindings: unknown[]) {
      const statement = db.query(query);
      const upper = query.trimStart().toUpperCase();
      if (upper.startsWith("SELECT") || upper.startsWith("PRAGMA")) {
        return { toArray: () => statement.all(...(bindings as never[])) };
      }
      statement.run(...(bindings as never[]));
      return { toArray: () => [] };
    },
  };
  ensureCapSchema(sql);
  return sql;
}

test("the room counter stops at the daily cap and rolls over at midnight UTC", () => {
  const sql = open();
  const now = new Date("2026-10-30T23:50:00.000Z");
  for (let i = 0; i < DAILY_CAP; i++) expect(claimSql(sql, now, DAILY_CAP).ok).toBe(true);
  const blocked = claimSql(sql, now, DAILY_CAP);
  expect(blocked.ok).toBe(false);
  expect(blocked.remaining).toBe(0);
  expect(blocked.resetsAt).toBe(nextMidnightUtc(now));
  refundSql(sql, now);
  expect(claimSql(sql, now, DAILY_CAP).ok).toBe(true);
  const next = claimSql(sql, new Date("2026-10-31T00:00:00.000Z"), DAILY_CAP);
  expect(next.ok).toBe(true);
  expect(next.used).toBe(1);
});

test("a room id is known only until it expires", () => {
  const sql = open();
  const now = 1_700_000_000_000;
  expect(roomKnownSql(sql, "k7m2pqrs", now)).toBe(false);
  expect(rememberRoomSql(sql, "k7m2pqrs", now + 1000, now)).toBe(true);
  expect(rememberRoomSql(sql, "k7m2pqrs", now + 5000, now)).toBe(false);
  expect(roomKnownSql(sql, "k7m2pqrs", now + 500)).toBe(true);
  expect(roomKnownSql(sql, "k7m2pqrs", now + 1000)).toBe(false);
  expect(rememberRoomSql(sql, "k7m2pqrs", now + 9000, now + 1000)).toBe(true);
  forgetRoomSql(sql, "k7m2pqrs");
  expect(roomKnownSql(sql, "k7m2pqrs", now + 1000)).toBe(false);
});
