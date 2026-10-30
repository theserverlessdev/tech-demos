export const DEFAULT_DAILY_CAP = 400;

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

export function capMessage(cap: number): string {
  return `Lake Catalog has run ${cap} queries today. It resets at midnight UTC.`;
}

export function ensureCapSchema(sql: CapSql): void {
  sql.exec("CREATE TABLE IF NOT EXISTS queries (day TEXT PRIMARY KEY, count INTEGER NOT NULL)");
}

export function claimSql(sql: CapSql, now: Date, cap: number): ClaimResult {
  const day = utcDay(now);
  const resetsAt = nextMidnightUtc(now);
  const row = sql.exec("SELECT count AS n FROM queries WHERE day = ?", day).toArray()[0] as { n: number } | undefined;
  const used = row ? Number(row.n) : 0;
  if (used >= cap) return { ok: false, used, remaining: 0, cap, resetsAt };
  const next = used + 1;
  sql.exec(
    "INSERT INTO queries (day, count) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET count = excluded.count",
    day,
    next,
  );
  return { ok: true, used: next, remaining: cap - next, cap, resetsAt };
}
