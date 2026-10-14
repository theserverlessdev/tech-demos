import { LIMITS } from "../shared/limits";
import { HttpError } from "./errors";
import type { DemoEnv } from "./env";
import { parseIPv4, parseIPv6, dottedIPv4 } from "./ssrf";

export function dayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

/** HMAC of the network key. The address itself is not stored. */
export async function hashIpKey(ip: string, secret: string): Promise<string> {
  if (!secret) throw new HttpError(503, "budget_unconfigured", "Compare is off until IP_HASH_SECRET is set.");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`byok-playground-ip-v1:${networkKey(ip)}`));
  return hex(sig);
}

export function parseCap(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function usedToday(env: DemoEnv, day = dayKey()): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM compares WHERE day = ?`).bind(day).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/**
 * Atomic insert: one global daily cap and one per-ip_key cap.
 * D1 runs the SELECT in the same statement as the INSERT.
 */
export async function claimCompare(env: DemoEnv, ipKey: string, now = Date.now()): Promise<string> {
  const day = dayKey(now);
  const id = crypto.randomUUID();
  const dailyCap = parseCap(env.DAILY_COMPARE_CAP, LIMITS.dailyCompareCap);
  const ipCap = parseCap(env.IP_COMPARE_CAP, LIMITS.ipCompareCap);
  const result = await env.DB.prepare(
    `INSERT INTO compares (id, day, ip_key, created_at)
     SELECT ?, ?, ?, ?
     WHERE (SELECT COUNT(*) FROM compares WHERE day = ?) < ?
       AND (SELECT COUNT(*) FROM compares WHERE day = ? AND ip_key = ?) < ?`,
  )
    .bind(id, day, ipKey, now, day, dailyCap, day, ipKey, ipCap)
    .run();
  if ((result.meta?.changes ?? 0) === 0) {
    const globalUsed = await usedToday(env, day);
    if (globalUsed >= dailyCap) {
      throw new HttpError(503, "daily", "The shared Workers AI budget for today is used up. Try again tomorrow.");
    }
    throw new HttpError(429, "hourly", "This network has used its compare budget for today.");
  }
  return id;
}
