import { MAX_DRIVE_REQUESTS } from "../shared/constants";
import type { SqlRunner } from "./quota";

export function ensureRequestTable(sql: SqlRunner): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    used INTEGER NOT NULL
  )`);
  sql.exec("INSERT INTO requests (id, used) VALUES (1, 0) ON CONFLICT(id) DO NOTHING");
}

export const BUDGET_EXHAUSTED_MESSAGE = "This drive has used its request budget. Mint a new drive when this one expires.";

/**
 * One atomic increment of `units`. False once this drive cannot afford them.
 * Zero units succeeds without writing, so a single-object COPY or MOVE stays on the request's own unit.
 */
export function takeUnits(sql: SqlRunner, units: number): boolean {
  if (!Number.isSafeInteger(units) || units < 0) return false;
  if (units === 0) return true;
  ensureRequestTable(sql);
  const rows = sql
    .exec("UPDATE requests SET used = used + ?1 WHERE id = 1 AND used + ?1 <= ?2 RETURNING used", units, MAX_DRIVE_REQUESTS)
    .toArray();
  return rows.length === 1;
}

/** One unit for this WebDAV request or live-log connection. */
export function takeRequest(sql: SqlRunner): boolean {
  return takeUnits(sql, 1);
}

export function unitsUsed(sql: SqlRunner): number {
  ensureRequestTable(sql);
  const row = sql.exec("SELECT used FROM requests WHERE id = 1").toArray()[0] as { used?: unknown } | undefined;
  return typeof row?.used === "number" ? row.used : Number(row?.used ?? 0);
}

export function setUnitsUsed(sql: SqlRunner, used: number): void {
  ensureRequestTable(sql);
  sql.exec("UPDATE requests SET used = ?1 WHERE id = 1", used);
}

export function budgetExhaustedResponse(detail: { driveId: string; needed: number; used: number }): Response {
  console.error(JSON.stringify({ event: "drive_budget_exhausted", driveId: detail.driveId, needed: detail.needed, used: detail.used }));
  return new Response(BUDGET_EXHAUSTED_MESSAGE, { status: 429 });
}

/** The gate `DriveObject.fetch` and the test server both call. Null means the unit was taken. */
export function chargeRequest(sql: SqlRunner, driveId = ""): Response | null {
  if (takeRequest(sql)) return null;
  return budgetExhaustedResponse({ driveId, needed: 1, used: unitsUsed(sql) });
}

/** A COPY or MOVE that cannot be paid for while units remain. The lifetime message is only for a spent budget. */
export function copyMoveBudgetResponse(driveId: string, needed: number, used: number): Response {
  const left = MAX_DRIVE_REQUESTS - used;
  console.error(JSON.stringify({ event: "drive_budget_exhausted", driveId, needed, used }));
  if (left <= 0) return new Response(BUDGET_EXHAUSTED_MESSAGE, { status: 429 });
  return new Response(`This copy/move needs ${needed} units; ${left} left.`, { status: 429 });
}
