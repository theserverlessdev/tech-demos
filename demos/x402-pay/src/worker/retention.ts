import type { Sql } from "./sql";

/** How long a row stays after its session expires. Session expiry is already `created_at + SESSION_TTL`. */
export const RETENTION_GRACE_MS = 24 * 60 * 60 * 1000;

export type PurgeCounts = {
  sessions: number;
  timeline: number;
  confirmations: number;
  fingerprints: number;
};

/**
 * Deletes expired D1 rows. Not called from a request or a cron.
 * Turning it on deletes stored rows and needs an explicit operator authorization first.
 * PayAgent and PayMCP SQLite are not touched here.
 */
export async function purgeExpiredRows(sql: Sql, now: number): Promise<PurgeCounts> {
  const sessionCutoff = now - RETENTION_GRACE_MS;
  const timeline = await sql.run(`DELETE FROM timeline WHERE session_id IN (SELECT id FROM sessions WHERE expires_at < ?)`, [sessionCutoff]);
  const confirmations = await sql.run(`DELETE FROM confirmations WHERE session_id IN (SELECT id FROM sessions WHERE expires_at < ?)`, [sessionCutoff]);
  const sessions = await sql.run(`DELETE FROM sessions WHERE expires_at < ?`, [sessionCutoff]);
  const fingerprints = await sql.run(`DELETE FROM fingerprints WHERE created_at < ?`, [sessionCutoff]);
  return { sessions, timeline, confirmations, fingerprints };
}
