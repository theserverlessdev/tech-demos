export const DESK_PATH = /^\/agents\/apollo\/[a-z0-9]{12,32}\/?$/;

export const MAX_TOOL_CALLS_PER_ROUND = 4;
export const MAX_REMINDER_SCHEDULES = 20;
export const MAX_PENDING_DEVICE_MESSAGES = 20;
export const MAX_DESK_TURNS_PER_DAY = 60;
export const INSPECT_MIN_INTERVAL_MS = 500;
export const METER_CACHE_MS = 10_000;
export const VISITOR_BUDGET_SHARE = 0.15;
export const MAX_HELLO_FAILS = 5;

export const SCOPED_GUARD_CODES = ["turnstile_required", "rate_limited", "desk_limited", "budget"] as const;

export function isScopedGuardCode(code: string): boolean {
  return (SCOPED_GUARD_CODES as readonly string[]).includes(code);
}

export function nextHelloFails(current = 0): { fails: number; close: boolean } {
  const fails = current + 1;
  return { fails, close: fails >= MAX_HELLO_FAILS };
}

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

/** Expand `::` and return 8 hextets, or null if `ip` is not IPv6. */
export function expandIpv6(ip: string): string[] | null {
  const raw = ip.trim().replace(/^\[(.+)\]$/, "$1").split("%")[0] ?? "";
  if (!raw.includes(":")) return null;
  if (raw.includes(".")) return null;
  const halves = raw.split("::");
  if (halves.length > 2) return null;
  const parse = (side: string | undefined) => (side ? side.split(":") : []);
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if (head.some((h) => !h || !/^[0-9a-fA-F]{1,4}$/.test(h))) return null;
  if (tail.some((h) => !h || !/^[0-9a-fA-F]{1,4}$/.test(h))) return null;
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    return head.map((h) => h.toLowerCase().replace(/^0+(?=\w)/, "") || "0");
  }
  if (head.length + tail.length > 8) return null;
  const missing = 8 - head.length - tail.length;
  const full = [...head, ...Array<string>(missing).fill("0"), ...tail];
  return full.map((h) => h.toLowerCase().replace(/^0+(?=\w)/, "") || "0");
}

/** IPv4 stays as-is. IPv6 collapses to the /64. Other keys (`desk:name`) pass through. */
export function networkKey(ip: string): string {
  const raw = ip.trim().replace(/^\[(.+)\]$/, "$1");
  if (!raw) return "local";
  const mapped = raw.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) return mapped[1]!;
  const parts = expandIpv6(raw);
  if (!parts) return raw;
  return parts.slice(0, 4).join(":");
}

export function ipSpendKey(ip: string, day = utcDayKey()): string {
  return `ip:${day}:${networkKey(ip)}`;
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
