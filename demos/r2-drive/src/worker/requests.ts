import { MAX_DRIVE_REQUESTS } from "../shared/constants";
import type { SqlRunner } from "./quota";

export function ensureRequestTable(sql: SqlRunner): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    used INTEGER NOT NULL
  )`);
  sql.exec("INSERT INTO requests (id, used) VALUES (1, 0) ON CONFLICT(id) DO NOTHING");
}

/** One atomic increment. False once this drive has spent its lifetime budget. */
export function takeRequest(sql: SqlRunner): boolean {
  ensureRequestTable(sql);
  const rows = sql.exec("UPDATE requests SET used = used + 1 WHERE id = 1 AND used < ? RETURNING used", MAX_DRIVE_REQUESTS).toArray();
  return rows.length === 1;
}
