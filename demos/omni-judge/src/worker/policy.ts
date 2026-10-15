import { LIMITS } from "../shared/limits";

function parseIPv4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

function parseIPv6(ip: string): bigint | null {
  let text = ip.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  if (text.includes(".")) {
    const last = text.lastIndexOf(":");
    if (last < 0) return null;
    const v4 = parseIPv4(text.slice(last + 1));
    if (v4 === null) return null;
    const hi = (v4 >>> 16).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    text = `${text.slice(0, last)}:${hi}:${lo}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  const groups = [...left, ...Array<string>(missing).fill("0"), ...right];
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    value = (value << 16n) + BigInt(parseInt(group, 16));
  }
  return value;
}

function dotted(value: number): string {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}

/** IPv4 as dotted decimal, or the IPv6 /56. Mapped IPv6 uses the embedded IPv4. */
export function networkKey(ip: string): string {
  const trimmed = ip.trim();
  if (!trimmed || trimmed === "local") return "local";
  const v4 = parseIPv4(trimmed);
  if (v4 !== null) return dotted(v4);
  const v6 = parseIPv6(trimmed);
  if (v6 === null) return "local";
  if (v6 >> 32n === 0xffffn) return dotted(Number(v6 & 0xffffffffn));
  const prefix = v6 & (~0n << 72n);
  const parts: string[] = [];
  for (let i = 0; i < 4; i++) parts.push(((prefix >> BigInt(112 - 16 * i)) & 0xffffn).toString(16));
  return `${parts.join(":")}::`;
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** HMAC of the network key. The address itself is not stored. */
export async function hashIpKey(ip: string, secret: string): Promise<string> {
  if (!secret) throw new Error("IP_HASH_SECRET is not set.");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`omni-judge-ip-v1:${networkKey(ip)}`));
  return hex(sig);
}

export function budgetDecision(input: { visitor: number; network: number; daily: number }): { ok: true } | { ok: false; status: 429 | 503; code: "hourly" | "daily"; message: string } {
  if (input.daily >= LIMITS.dailyCap) return { ok: false, status: 503, code: "daily", message: "The demo has reached its limit for today. Try again tomorrow." };
  if (input.visitor >= LIMITS.perVisitorHour) return { ok: false, status: 429, code: "hourly", message: "This browser has used its judgments for this hour." };
  if (input.network >= LIMITS.perNetworkHour) return { ok: false, status: 429, code: "hourly", message: "This network has used its judgments for this hour." };
  return { ok: true };
}
