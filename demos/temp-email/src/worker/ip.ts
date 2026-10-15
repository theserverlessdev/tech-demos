/** Collapse IPv6 to a /64 so one prefix cannot mint unlimited rate-limit keys. IPv4 is unchanged. */
export function rateLimitIp(ip: string): string {
  if (!ip || ip === "local") return ip;
  const mapped = ipv4Mapped(ip);
  if (mapped) return mapped;
  if (!ip.includes(":")) return ip;
  const groups = expandIpv6(ip);
  if (!groups) return ip;
  return `${groups[0]}:${groups[1]}:${groups[2]}:${groups[3]}`;
}

export function webCreateLimitKey(hosted: boolean, ip: string): string | null {
  return hosted ? `webcreate:${rateLimitIp(ip)}` : null;
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
    if (parts.some((p) => !/^[0-9a-f]{1,4}$/.test(p))) return null;
    return parts;
  };
  if (halves.length === 1) {
    const parts = parse(halves[0]);
    if (!parts || parts.length !== 8) return null;
    return parts.map((p) => p.padStart(4, "0"));
  }
  const left = parse(halves[0]);
  const right = parse(halves[1]);
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  return [...left, ...Array(missing).fill("0"), ...right].map((p) => p.padStart(4, "0"));
}
