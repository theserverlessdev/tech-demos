import { LIMITS } from "../shared/limits";
import { addressBlocked, assessUrl, dottedIPv4, isBlockedIp, parseIPv4, parseIPv6, type Decision, type Lookup } from "./ssrf";

/** Newest startTime first. Empty ids are dropped. */
export function rankSessions<T extends { sessionId: string; startTime: number }>(listed: T[]): T[] {
  return listed.filter((session) => session.sessionId.length > 0).sort((a, b) => b.startTime - a.startTime);
}

/** A failed measurement (null) is not capacity. The caller tries the next session. */
export function sessionHasCapacity(contextCount: number | null, maxContexts = LIMITS.maxContexts): boolean {
  return contextCount !== null && contextCount < maxContexts;
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

/**
 * Scheme and port are assessed on every request. Only the DNS answer is cached,
 * and only for subresources. Main-frame hops call authorizeNavigation directly.
 * Past maxSubresourceHosts, a new host is rejected with no lookup.
 */
export async function authorizeSubresource(raw: string, cache: Map<string, Promise<string[]>>, lookup: Lookup, maxHosts = LIMITS.maxSubresourceHosts): Promise<Decision> {
  const assessed = assessUrl(raw);
  if (!assessed.ok) return assessed;
  const host = new URL(assessed.url).hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (addressBlocked(host) !== null) return assessed;
  if (!cache.has(host) && cache.size >= maxHosts) {
    return { ok: false, code: "ssrf", message: "The page asked for too many hosts." };
  }
  let pending = cache.get(host);
  if (!pending) {
    pending = lookup(host);
    cache.set(host, pending);
  }
  let addresses: string[];
  try {
    addresses = await pending;
  } catch {
    return { ok: false, code: "dns", message: "The hostname could not be resolved." };
  }
  if (addresses.length === 0) return { ok: false, code: "dns", message: "The hostname did not resolve." };
  for (const address of addresses) {
    if (addressBlocked(address) !== false) return { ok: false, code: "ssrf", message: "DNS for that hostname includes a blocked address." };
  }
  return assessed;
}

function prefixGroups(ip: bigint, groups: number): string {
  const parts: string[] = [];
  for (let i = 0; i < groups; i++) parts.push(((ip >> BigInt(112 - 16 * i)) & 0xffffn).toString(16));
  return `${parts.join(":")}::`;
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
  return prefixGroups(v6 & ~((1n << 64n) - 1n), 4);
}

/** IPv6 /48. IPv4 and mapped IPv4 use the whole address, which is already inside the tighter /64 cap. */
export function network48(ip: string): string {
  const trimmed = ip.trim();
  if (!trimmed || trimmed === "local") return "local";
  const v4 = parseIPv4(trimmed);
  if (v4 !== null) return dottedIPv4(v4);
  const v6 = parseIPv6(trimmed);
  if (v6 === null) return "local";
  if (v6 >> 32n === 0xffffn) return dottedIPv4(Number(v6 & 0xffffffffn));
  return prefixGroups(v6 & ~((1n << 80n) - 1n), 3);
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** HMAC of the network key. The address itself is not stored. */
export async function hashIpKey(ip: string, secret: string, scope: "64" | "48" = "64"): Promise<string> {
  if (!secret) throw new Error("IP_HASH_SECRET is not set.");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const label = scope === "48" ? network48(ip) : networkKey(ip);
  const prefix = scope === "48" ? "edge-browser-ip48-v1" : "edge-browser-ip-v1";
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${prefix}:${label}`));
  return hex(sig);
}

export function budgetDecision(input: { cookie: number; network: number; network48: number; daily: number }): { ok: true } | { ok: false; status: 429 | 503; code: "hourly" | "daily"; message: string } {
  if (input.daily >= LIMITS.dailyCap) return { ok: false, status: 503, code: "daily", message: "daily budget used up" };
  if (input.cookie >= LIMITS.capturesPerHour) return { ok: false, status: 429, code: "hourly", message: "This browser has used its 6 captures for this hour." };
  if (input.network >= LIMITS.capturesPerHour) return { ok: false, status: 429, code: "hourly", message: "This network has used its 6 captures for this hour." };
  if (input.network48 >= LIMITS.network48PerHour) return { ok: false, status: 429, code: "hourly", message: "This network has used its 20 captures for this hour." };
  return { ok: true };
}
