import { LIMITS } from "../shared/limits";
import { parseIPv4, parseIPv6, dottedIPv4, authorizeNavigation, type Decision, type Lookup, isBlockedIp } from "./ssrf";

/** What to do with Browser Rendering after sessions() and, when connected, Target.getBrowserContexts. */
export type ReusePlan = "connect" | "launch-warm" | "launch-one-off";

/**
 * No stored inflight counter. A listed session is reused only when its context
 * count is under the cap. A full session means a one-off browser that the caller closes.
 * A failed measurement (null) is not reused.
 */
export function reusePlan(sessionIds: string[], contextCount: number | null, maxContexts = LIMITS.maxContexts): ReusePlan {
  const sessionId = sessionIds.find((id) => id.length > 0);
  if (!sessionId) return "launch-warm";
  if (contextCount === null) return "launch-one-off";
  if (contextCount < maxContexts) return "connect";
  return "launch-one-off";
}

/** Refuse a new browser when either acquisitions are exhausted or the account is already at the session cap. */
export function acquisitionsAllowed(input: { allowedBrowserAcquisitions: number; activeSessions: number; maxConcurrentSessions: number }): boolean {
  if (input.allowedBrowserAcquisitions <= 0) return false;
  if (input.maxConcurrentSessions > 0 && input.activeSessions >= input.maxConcurrentSessions) return false;
  return true;
}

export function sessionPrefix(sessionId: string): string {
  return sessionId.slice(0, 8);
}

/**
 * Fail closed only for a finished response whose remote IP is blocked.
 * A missing IP, a 3xx, or status 0 (Chrome internal redirect) does not fail the capture.
 */
export function completedPrivateResponse(ip: string | undefined, status: number): boolean {
  if (!ip) return false;
  if (status === 0 || (status >= 300 && status < 400)) return false;
  return isBlockedIp(ip);
}

export type PageGuard = {
  blockMain: (message: string) => void;
  abortSubresource: () => void;
  noteResponse: (ip: string | undefined, status: number) => void;
  failure: () => string | null;
};

export function createGuard(): PageGuard {
  let main: string | null = null;
  let privateHit: string | null = null;
  return {
    blockMain(message) {
      main = main ?? message;
    },
    abortSubresource() {
      /* An aborted subresource is not a capture failure. */
    },
    noteResponse(ip, status) {
      if (completedPrivateResponse(ip, status)) privateHit = privateHit ?? "The page connected to a blocked address.";
    },
    failure() {
      return main ?? privateHit;
    },
  };
}

/** One DoH lookup per hostname for the life of the page. */
export function cachedAuthorize(cache: Map<string, Promise<Decision>>, raw: string, lookup: Lookup): Promise<Decision> {
  let host = "";
  try {
    host = new URL(raw).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    host = "";
  }
  const key = host || raw;
  const existing = cache.get(key);
  if (existing) return existing;
  const pending = authorizeNavigation(raw, lookup);
  cache.set(key, pending);
  return pending;
}

/** IPv4 as dotted decimal, or the IPv6 /64. Mapped IPv6 uses the embedded IPv4. */
export function networkKey(ip: string): string {
  const trimmed = ip.trim();
  if (!trimmed || trimmed === "local") return "local";
  const v4 = parseIPv4(trimmed);
  if (v4 !== null) return dottedIPv4(v4);
  const v6 = parseIPv6(trimmed);
  if (v6 === null) return "local";
  if (v6 >> 32n === 0xffffn) return dottedIPv4(Number(v6 & 0xffffffffn));
  const prefix = v6 & ~((1n << 64n) - 1n);
  const groups: string[] = [];
  for (let i = 0; i < 4; i++) groups.push(((prefix >> BigInt(112 - 16 * i)) & 0xffffn).toString(16));
  return `${groups.join(":")}::`;
}

export async function hashIpKey(ip: string): Promise<string> {
  const material = new TextEncoder().encode(`edge-browser-ip-v1:${networkKey(ip)}`);
  const digest = await crypto.subtle.digest("SHA-256", material);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function budgetDecision(input: { cookie: number; network: number; daily: number }): { ok: true } | { ok: false; status: 429 | 503; code: "hourly" | "daily"; message: string } {
  if (input.daily >= LIMITS.dailyCap) return { ok: false, status: 503, code: "daily", message: "daily budget used up" };
  if (input.cookie >= LIMITS.capturesPerHour) return { ok: false, status: 429, code: "hourly", message: "This browser has used its 6 captures for this hour." };
  if (input.network >= LIMITS.capturesPerHour) return { ok: false, status: 429, code: "hourly", message: "This network has used its 6 captures for this hour." };
  return { ok: true };
}
