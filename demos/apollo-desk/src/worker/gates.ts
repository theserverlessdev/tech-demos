export const DESK_PATH = /^\/agents\/apollo\/[a-z0-9]{12,32}\/?$/;

export const MAX_TOOL_CALLS_PER_ROUND = 4;
export const MAX_REMINDER_SCHEDULES = 20;
export const MAX_PENDING_DEVICE_MESSAGES = 20;
export const MAX_DESK_TURNS_PER_DAY = 60;
export const INSPECT_MIN_INTERVAL_MS = 500;
export const METER_CACHE_MS = 10_000;
export const VISITOR_BUDGET_SHARE = 0.15;

export function isStaticAssetPath(path: string): boolean {
  return path === "/" || path === "/index.html" || path === "/favicon.svg" || path.startsWith("/assets/");
}

export function clampDeviceLevel(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : undefined;
}

export function formatBudgetUsd(budget: number): string {
  return budget < 0.1 ? budget.toFixed(3) : budget.toFixed(2);
}

export function utcDayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function ipSpendKey(ip: string, day = utcDayKey()): string {
  return `ip:${day}:${ip}`;
}

export function visitorCapUsd(budget: number): number {
  return budget * VISITOR_BUDGET_SHARE;
}

export const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com https://static.cloudflareinsights.com",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "connect-src 'self' https://challenges.cloudflare.com https://cloudflareinsights.com",
  "img-src 'self' data:",
  "frame-src https://challenges.cloudflare.com",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");
