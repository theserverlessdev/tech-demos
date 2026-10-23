/** IPv6 clients share a /64. Rate-limit and budget that prefix, not the full address. */
export function networkKey(ip: string): string {
  if (!ip || ip === "local" || ip.includes(".")) return ip || "local";
  const expanded = expandIPv6(ip);
  if (!expanded) return ip;
  return `${expanded.slice(0, 4).join(":")}::/64`;
}

export function clientIp(request: Request): string {
  const cf = request.headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  return "0.0.0.0";
}

/** HMAC of the network key. The raw address is not stored. */
export async function hashIp(ip: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(networkKey(ip)));
  return [...new Uint8Array(sig)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function expandIPv6(ip: string): string[] | null {
  if (ip.includes("%")) ip = ip.slice(0, ip.indexOf("%"));
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (left.some((part) => !isHextet(part)) || right.some((part) => !isHextet(part))) return null;
  const missing = 8 - left.length - right.length;
  if (halves.length === 1) {
    if (left.length !== 8) return null;
    return left.map(normalizeHextet);
  }
  if (missing < 0) return null;
  return [...left, ...Array<string>(missing).fill("0"), ...right].map(normalizeHextet);
}

function isHextet(part: string): boolean {
  return /^[0-9a-f]{1,4}$/i.test(part);
}

function normalizeHextet(part: string): string {
  return part.toLowerCase().padStart(4, "0");
}
