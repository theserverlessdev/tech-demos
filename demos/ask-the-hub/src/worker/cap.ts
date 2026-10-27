export const DAILY_CAP = 200;
export const SEARCH_DAILY_CAP = 1000;
export const TOKEN_TTL_MS = 120_000;
export const TOKEN_USE_LIMIT = 2;

export type ClaimResult = {
  ok: boolean;
  used: number;
  remaining: number;
  cap: number;
  resetsAt: string;
};

export type TokenDecision = "absent" | "replay" | "spent";

export type CapTable = "asks" | "searches";

export type CapSql = {
  exec(query: string, ...bindings: unknown[]): {
    toArray(): unknown[];
  };
};

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Midnight UTC after `now`, as an ISO string. */
export function nextMidnightUtc(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
}

export function capMessage(cap: number): string {
  return `Ask the Hub has answered ${cap} questions today. It resets at midnight UTC.`;
}

export function searchCapMessage(cap: number): string {
  return `Ask the Hub has searched the notes ${cap} times today. It resets at midnight UTC.`;
}

export function ensureCapSchema(sql: CapSql): void {
  sql.exec("CREATE TABLE IF NOT EXISTS asks (day TEXT PRIMARY KEY, count INTEGER NOT NULL)");
  sql.exec("CREATE TABLE IF NOT EXISTS searches (day TEXT PRIMARY KEY, count INTEGER NOT NULL)");
  sql.exec("CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, exp INTEGER NOT NULL, uses INTEGER NOT NULL)");
  const columns = sql.exec("PRAGMA table_info(tokens)").toArray() as { name?: string }[];
  if (!columns.some((column) => column.name === "uses")) {
    sql.exec("ALTER TABLE tokens ADD COLUMN uses INTEGER NOT NULL DEFAULT 1");
  }
}

/** Read-then-write one day's counter. AskCap runs this inside blockConcurrencyWhile. */
export function claimSql(sql: CapSql, table: CapTable, now: Date, cap: number): ClaimResult {
  const day = utcDay(now);
  const resetsAt = nextMidnightUtc(now);
  const row = sql.exec(`SELECT count AS n FROM ${table} WHERE day = ?`, day).toArray()[0] as { n: number } | undefined;
  const used = row ? Number(row.n) : 0;
  if (used >= cap) return { ok: false, used, remaining: 0, cap, resetsAt };
  const next = used + 1;
  sql.exec(
    `INSERT INTO ${table} (day, count) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET count = excluded.count`,
    day,
    next,
  );
  return { ok: true, used: next, remaining: cap - next, cap, resetsAt };
}

/** Give back one slot after a failed search. Never drops below zero. */
export function refundSql(sql: CapSql, table: CapTable, now: Date): void {
  const day = utcDay(now);
  const row = sql.exec(`SELECT count AS n FROM ${table} WHERE day = ?`, day).toArray()[0] as { n: number } | undefined;
  const used = row ? Number(row.n) : 0;
  if (used <= 0) return;
  sql.exec(
    `INSERT INTO ${table} (day, count) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET count = excluded.count`,
    day,
    used - 1,
  );
}

/**
 * Insert a token once, after a fresh siteverify success. The insert is the first
 * of two uses. A later insert does not move the expiry.
 *
 * A returned row means the insert happened. Durable Object SQLite counts the
 * primary-key index in rowsWritten, so a successful insert reports 2.
 */
export function rememberSql(sql: CapSql, hash: string, now: number): boolean {
  const inserted = sql
    .exec(
      "INSERT INTO tokens (hash, exp, uses) VALUES (?, ?, 1) ON CONFLICT(hash) DO NOTHING RETURNING hash",
      hash,
      now + TOKEN_TTL_MS,
    )
    .toArray();
  sql.exec("DELETE FROM tokens WHERE exp <= ?", now);
  return inserted.length === 1;
}

/** Spend one saved use. Expired and exhausted rows stay as they are. */
export function takeSql(sql: CapSql, hash: string, now: number): TokenDecision {
  const updated = sql
    .exec(
      "UPDATE tokens SET uses = uses + 1 WHERE hash = ? AND uses < ? AND exp > ? RETURNING uses",
      hash,
      TOKEN_USE_LIMIT,
      now,
    )
    .toArray();
  if (updated.length === 1) return "replay";
  const existing = sql.exec("SELECT hash FROM tokens WHERE hash = ?", hash).toArray();
  return existing.length === 0 ? "absent" : "spent";
}
