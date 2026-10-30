export const CAP_MESSAGE = "Pairlane has opened 240 rooms today. It resets at midnight UTC.";

export type ClaimResult = {
  ok: boolean;
  used: number;
  remaining: number;
  cap: number;
  resetsAt: string;
};

export type CapSql = {
  exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] };
};

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function nextMidnightUtc(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
}

export function ensureCapSchema(sql: CapSql): void {
  sql.exec("CREATE TABLE IF NOT EXISTS creates (day TEXT PRIMARY KEY, count INTEGER NOT NULL)");
  sql.exec("CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, exp INTEGER NOT NULL)");
}

export function claimSql(sql: CapSql, now: Date, cap: number): ClaimResult {
  const day = utcDay(now);
  const resetsAt = nextMidnightUtc(now);
  const row = sql.exec("SELECT count AS n FROM creates WHERE day = ?", day).toArray()[0] as { n: number } | undefined;
  const used = row ? Number(row.n) : 0;
  if (used >= cap) return { ok: false, used, remaining: 0, cap, resetsAt };
  const next = used + 1;
  sql.exec(
    "INSERT INTO creates (day, count) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET count = excluded.count",
    day,
    next,
  );
  return { ok: true, used: next, remaining: cap - next, cap, resetsAt };
}

export function refundSql(sql: CapSql, now: Date): void {
  const day = utcDay(now);
  const row = sql.exec("SELECT count AS n FROM creates WHERE day = ?", day).toArray()[0] as { n: number } | undefined;
  const used = row ? Number(row.n) : 0;
  if (used <= 0) return;
  sql.exec(
    "INSERT INTO creates (day, count) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET count = excluded.count",
    day,
    used - 1,
  );
}

/** Reserve a room id. A live id is left untouched so two creates cannot share it. */
export function rememberRoomSql(sql: CapSql, id: string, exp: number, now: number): boolean {
  sql.exec("DELETE FROM rooms WHERE exp <= ?", now);
  const existing = sql.exec("SELECT id FROM rooms WHERE id = ?", id).toArray();
  if (existing.length > 0) return false;
  sql.exec("INSERT INTO rooms (id, exp) VALUES (?, ?)", id, exp);
  return true;
}

export function forgetRoomSql(sql: CapSql, id: string): void {
  sql.exec("DELETE FROM rooms WHERE id = ?", id);
}

export function roomKnownSql(sql: CapSql, id: string, now: number): boolean {
  sql.exec("DELETE FROM rooms WHERE exp <= ?", now);
  const rows = sql.exec("SELECT id FROM rooms WHERE id = ? AND exp > ?", id, now).toArray();
  return rows.length === 1;
}
