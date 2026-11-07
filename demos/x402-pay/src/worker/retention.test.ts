import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SESSION_TTL_MS } from "../shared/protocol";
import { RETENTION_GRACE_MS, purgeExpiredRows } from "./retention";
import type { Sql } from "./sql";

const migration = readFileSync(new URL("../../migrations/0001_ledger.sql", import.meta.url), "utf8");

function memory(): Sql {
  const db = new Database(":memory:");
  db.exec(migration);
  return {
    async run(query, params = []) {
      return Number(db.query(query).run(...(params as never[])).changes ?? 0);
    },
    async get<T extends Record<string, unknown>>(query, params = []) {
      return (db.query(query).get(...(params as never[])) as T | null) ?? null;
    },
    async all<T extends Record<string, unknown>>(query, params = []) {
      return db.query(query).all(...(params as never[])) as T[];
    },
  };
}

test("purge removes rows that have been expired for a day and leaves newer ones", async () => {
  const sql = memory();
  const now = Date.UTC(2026, 10, 7, 12, 0, 0);
  const oldExpiry = now - RETENTION_GRACE_MS - 1;
  const freshExpiry = now + SESSION_TTL_MS;
  await sql.run(`INSERT INTO sessions (id, token_hash, created_at, expires_at) VALUES ('old', 'old-hash', ?, ?)`, [oldExpiry - SESSION_TTL_MS, oldExpiry]);
  await sql.run(`INSERT INTO sessions (id, token_hash, created_at, expires_at) VALUES ('new', 'new-hash', ?, ?)`, [now, freshExpiry]);
  await sql.run(`INSERT INTO timeline (session_id, at, kind, detail) VALUES ('old', ?, 'http_402', '{}')`, [oldExpiry]);
  await sql.run(`INSERT INTO timeline (session_id, at, kind, detail) VALUES ('new', ?, 'http_402', '{}')`, [now]);
  await sql.run(
    `INSERT INTO confirmations (id, session_id, tool, args_json, binding, network, asset, pay_to, amount, scheme, status, expires_at, created_at, updated_at) VALUES ('c-old', 'old', 'square', '{}', 'b', 'eip155:84532', '0x0', '0x0', '10000', 'exact', 'denied', ?, ?, ?)`,
    [oldExpiry, oldExpiry, oldExpiry],
  );
  await sql.run(
    `INSERT INTO confirmations (id, session_id, tool, args_json, binding, network, asset, pay_to, amount, scheme, status, expires_at, created_at, updated_at) VALUES ('c-new', 'new', 'square', '{}', 'b', 'eip155:84532', '0x0', '0x0', '10000', 'exact', 'requested', ?, ?, ?)`,
    [freshExpiry, now, now],
  );
  await sql.run(`INSERT INTO fingerprints (fingerprint, status, created_at) VALUES ('old-fp', 'executed', ?)`, [now - RETENTION_GRACE_MS - 1]);
  await sql.run(`INSERT INTO fingerprints (fingerprint, status, created_at) VALUES ('new-fp', 'executed', ?)`, [now]);

  const counts = await purgeExpiredRows(sql, now);
  expect(counts.sessions).toBe(1);
  expect(counts.timeline).toBe(1);
  expect(counts.confirmations).toBe(1);
  expect(counts.fingerprints).toBe(1);
  expect(await sql.get(`SELECT id FROM sessions WHERE id = 'old'`)).toBeNull();
  expect(await sql.get<{ id: string }>(`SELECT id FROM sessions WHERE id = 'new'`)).toEqual({ id: "new" });
  expect(await sql.get(`SELECT id FROM confirmations WHERE id = 'c-old'`)).toBeNull();
  expect(await sql.get<{ id: string }>(`SELECT id FROM confirmations WHERE id = 'c-new'`)).toEqual({ id: "c-new" });
  expect(await sql.get(`SELECT fingerprint FROM fingerprints WHERE fingerprint = 'old-fp'`)).toBeNull();
  expect(await sql.get<{ fingerprint: string }>(`SELECT fingerprint FROM fingerprints WHERE fingerprint = 'new-fp'`)).toEqual({ fingerprint: "new-fp" });
});
