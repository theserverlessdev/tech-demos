/** IPv6 /64, IPv4 unchanged. Same collapse the other demos use for rate-limit keys. */
export function rateLimitIp(ip: string): string {
  if (!ip || ip === "local") return ip || "local";
  const mapped = ipv4Mapped(ip);
  if (mapped) return mapped;
  if (!ip.includes(":")) return ip;
  const groups = expandIpv6(ip);
  if (!groups) return ip;
  return groups.slice(0, 4).join(":");
}

/**
 * Network key for mint quotas and abuse blocks.
 * IPv6 is a /64. IPv4 is a /24 because a /64 does not apply to IPv4.
 */
export function clientNetwork(ip: string): string {
  const key = rateLimitIp(ip);
  if (!key.includes(".")) return key;
  const parts = key.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return key;
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}

export function clientIp(request: Request): string {
  const cf = request.headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  return "local";
}

function ipv4Mapped(ip: string): string | null {
  const lower = ip.toLowerCase();
  if (!lower.startsWith("::ffff:")) return null;
  const rest = ip.slice("::ffff:".length);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rest)) return rest;
  return null;
}

function expandIpv6(ip: string): string[] | null {
  const pct = ip.indexOf("%");
  const raw = (pct === -1 ? ip : ip.slice(0, pct)).toLowerCase();
  if (raw.includes(".")) return null;
  const halves = raw.split("::");
  if (halves.length > 2) return null;
  const parse = (side: string | undefined): string[] | null => {
    if (!side) return [];
    const parts = side.split(":");
    if (parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
    return parts;
  };
  if (halves.length === 1) {
    const parts = parse(halves[0]);
    if (!parts || parts.length !== 8) return null;
    return parts.map((part) => part.padStart(4, "0"));
  }
  const left = parse(halves[0]);
  const right = parse(halves[1]);
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  return [...left, ...Array<string>(missing).fill("0000"), ...right].map((part) => part.padStart(4, "0"));
}
