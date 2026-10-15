/** One visitor cannot take more than this share of the global day. Two solves cannot exhaust the demo. */
export const DEFAULT_VISITOR_TURNS_PER_DAY = 40;
export const DEFAULT_AI_CALLS_PER_DAY = 300;

export const METER_MISSING_MESSAGE =
  "The AI budget table is missing. Apply D1 migration 0002 (ai_meter), then retry.";

export class MeterMissingError extends Error {
  constructor() {
    super(METER_MISSING_MESSAGE);
    this.name = "MeterMissingError";
  }
}

export function isMeterMissingError(err: unknown): boolean {
  if (err instanceof MeterMissingError) return true;
  const text = err instanceof Error ? err.message : String(err);
  return /no such table:\s*ai_meter/i.test(text) || text.includes("migration 0002");
}

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
