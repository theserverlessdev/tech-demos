import { BUSY_MS, utcDay, type LedgerStatus } from "../shared/protocol";
import type { Sql } from "./sql";

export type SessionRow = {
  id: string;
  token_hash: string;
  created_at: number;
  expires_at: number;
};

export type ConfirmationRow = {
  id: string;
  session_id: string;
  tool: string;
  args_json: string;
  binding: string;
  network: string;
  asset: string;
  pay_to: string;
  amount: string;
  scheme: string;
  status: LedgerStatus;
  expires_at: number;
  created_at: number;
  updated_at: number;
  result_text: string | null;
  transaction_id: string | null;
  settlement: string | null;
  error_code: string | null;
};

const CONFIRM_COLUMNS = `id, session_id, tool, args_json, binding, network, asset, pay_to, amount, scheme, status, expires_at, created_at, updated_at, result_text, transaction_id, settlement, error_code`;

export async function insertSession(sql: Sql, row: SessionRow): Promise<void> {
  await sql.run(
    `INSERT INTO sessions (id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)`,
    [row.id, row.token_hash, row.created_at, row.expires_at],
  );
}

export async function sessionByHash(sql: Sql, tokenHash: string, now: number): Promise<SessionRow | null> {
  return sql.get<SessionRow>(
    `SELECT id, token_hash, created_at, expires_at FROM sessions WHERE token_hash = ? AND expires_at > ?`,
    [tokenHash, now],
  );
}

export async function chargeDaily(sql: Sql, scope: string, day: string, kind: string, cap: number): Promise<boolean> {
  if (cap < 1) return false;
  const updated = await sql.run(
    `UPDATE daily_counts SET count = count + 1 WHERE scope = ? AND day = ? AND kind = ? AND count < ?`,
    [scope, day, kind, cap],
  );
  if (updated > 0) return true;
  try {
    await sql.run(`INSERT INTO daily_counts (scope, day, kind, count) VALUES (?, ?, ?, 1)`, [scope, day, kind]);
    return true;
  } catch {
    const again = await sql.run(
      `UPDATE daily_counts SET count = count + 1 WHERE scope = ? AND day = ? AND kind = ? AND count < ?`,
      [scope, day, kind, cap],
    );
    return again > 0;
  }
}

export async function insertConfirmation(sql: Sql, row: ConfirmationRow): Promise<void> {
  await sql.run(
    `INSERT INTO confirmations (${CONFIRM_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.session_id,
      row.tool,
      row.args_json,
      row.binding,
      row.network,
      row.asset,
      row.pay_to,
      row.amount,
      row.scheme,
      row.status,
      row.expires_at,
      row.created_at,
      row.updated_at,
      row.result_text,
      row.transaction_id,
      row.settlement,
      row.error_code,
    ],
  );
}

export async function confirmationById(sql: Sql, id: string): Promise<ConfirmationRow | null> {
  return sql.get<ConfirmationRow>(`SELECT ${CONFIRM_COLUMNS} FROM confirmations WHERE id = ?`, [id]);
}

export type Claim = { kind: "owned"; row: ConfirmationRow } | { kind: "replay"; row: ConfirmationRow } | { kind: "busy" } | { kind: "missing" } | { kind: "expired"; row: ConfirmationRow };

/**
 * One confirm owns the row. A retry of a finished row returns that row.
 * A retry while the first attempt is still inside the busy window does not start a second payment.
 * A stale approved row is marked failed and is not settled again.
 */
export async function claimConfirmation(sql: Sql, id: string, sessionId: string, now: number): Promise<Claim> {
  const row = await confirmationById(sql, id);
  if (!row || row.session_id !== sessionId) return { kind: "missing" };
  if (row.status === "settled" || row.status === "failed" || row.status === "denied") return { kind: "replay", row };
  if (row.status === "approved") {
    if (now - row.updated_at < BUSY_MS) return { kind: "busy" };
    await finishConfirmation(sql, id, { status: "failed", errorCode: "interrupted", now });
    const failed = await confirmationById(sql, id);
    return { kind: "replay", row: failed ?? { ...row, status: "failed", error_code: "interrupted" } };
  }
  if (row.expires_at <= now) {
    await finishConfirmation(sql, id, { status: "failed", errorCode: "expired", now });
    const expired = await confirmationById(sql, id);
    return { kind: "expired", row: expired ?? { ...row, status: "failed", error_code: "expired" } };
  }
  const changed = await sql.run(
    `UPDATE confirmations SET status = 'approved', updated_at = ? WHERE id = ? AND session_id = ? AND status = 'requested' AND expires_at > ?`,
    [now, id, sessionId, now],
  );
  if (changed !== 1) return { kind: "busy" };
  const owned = await confirmationById(sql, id);
  if (!owned) return { kind: "missing" };
  return { kind: "owned", row: owned };
}

export async function finishConfirmation(
  sql: Sql,
  id: string,
  patch: {
    status: LedgerStatus;
    now: number;
    text?: string;
    transaction?: string;
    settlement?: string;
    errorCode?: string;
  },
): Promise<void> {
  await sql.run(
    `UPDATE confirmations SET status = ?, updated_at = ?, result_text = COALESCE(?, result_text), transaction_id = COALESCE(?, transaction_id), settlement = COALESCE(?, settlement), error_code = COALESCE(?, error_code) WHERE id = ?`,
    [patch.status, patch.now, patch.text ?? null, patch.transaction ?? null, patch.settlement ?? null, patch.errorCode ?? null, id],
  );
}

export async function denyConfirmation(sql: Sql, id: string, sessionId: string, now: number): Promise<ConfirmationRow | null> {
  await sql.run(
    `UPDATE confirmations SET status = 'denied', updated_at = ?, error_code = 'denied' WHERE id = ? AND session_id = ? AND status = 'requested' AND expires_at > ?`,
    [now, id, sessionId, now],
  );
  return confirmationById(sql, id);
}

export async function appendTimeline(sql: Sql, sessionId: string, at: number, kind: string, detail: Record<string, string>): Promise<void> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (!/^[a-z0-9_]{1,24}$/.test(key)) continue;
    safe[key] = value.slice(0, 180);
  }
  await sql.run(`INSERT INTO timeline (session_id, at, kind, detail) VALUES (?, ?, ?, ?)`, [
    sessionId,
    at,
    kind.slice(0, 40),
    JSON.stringify(safe).slice(0, 500),
  ]);
}

export type TimelineItem = { at: number; kind: string; detail: string };

export async function timelineFor(sql: Sql, sessionId: string): Promise<TimelineItem[]> {
  const rows = await sql.all<{ at: number; kind: string; detail: string }>(
    `SELECT at, kind, detail FROM timeline WHERE session_id = ? ORDER BY id DESC LIMIT 40`,
    [sessionId],
  );
  return rows;
}

export async function claimFingerprint(sql: Sql, fingerprint: string, now: number): Promise<"new" | "replay" | "failed"> {
  try {
    await sql.run(`INSERT INTO fingerprints (fingerprint, status, created_at) VALUES (?, 'executing', ?)`, [fingerprint, now]);
    return "new";
  } catch {
    const row = await sql.get<{ status: string }>(`SELECT status FROM fingerprints WHERE fingerprint = ?`, [fingerprint]);
    if (!row || row.status === "failed") return "failed";
    return "replay";
  }
}

export async function finishFingerprint(sql: Sql, fingerprint: string, status: "executed" | "failed"): Promise<void> {
  await sql.run(`UPDATE fingerprints SET status = ? WHERE fingerprint = ?`, [status, fingerprint]);
}

export function dayOf(now: number): string {
  return utcDay(now);
}
