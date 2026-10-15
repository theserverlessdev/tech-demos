export const DEFAULT_VISITOR_TURNS_PER_DAY = 150;
export const DEFAULT_AI_CALLS_PER_DAY = 300;

export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function parseCap(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 && n <= 10_000 ? Math.floor(n) : fallback;
}

export function atCap(count: number, cap: number): boolean {
  return count >= cap;
}

export const CONSUME_GLOBAL_AI_SQL = `INSERT INTO ai_meter (day, calls) VALUES (?, 1)
ON CONFLICT(day) DO UPDATE SET calls = calls + 1
RETURNING calls`;

export const ROLLBACK_GLOBAL_AI_SQL = `UPDATE ai_meter SET calls = MAX(0, calls - 1) WHERE day = ?`;
