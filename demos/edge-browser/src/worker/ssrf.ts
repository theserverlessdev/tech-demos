export type Lookup = (hostname: string) => Promise<string[]>;

export type Decision = { ok: true; url: string } | { ok: false; code: "ssrf" | "dns" | "url"; message: string };

const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata",
  "metadata.google",
  "metadata.google.internal",
  "instance-data",
  "instance-data.ec2.internal",
]);

function fail(code: "ssrf" | "dns" | "url", message: string): Decision {
  return { ok: false, code, message };
}

function parsePart(part: string): number | null {
  if (part.length === 0 || part.length > 12) return null;
  let value: number;
  if (/^0x[0-9a-f]+$/i.test(part)) value = Number.parseInt(part.slice(2), 16);
  else if (part.length > 1 && part.startsWith("0") && /^[0-7]+$/.test(part)) value = Number.parseInt(part, 8);
  else if (/^\d+$/.test(part)) value = Number.parseInt(part, 10);
  else return null;
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

/** inet_aton-style IPv4: dotted, octal, hex, decimal, and short forms such as 127.1. */
export function parseIPv4(host: string): number | null {
  const raw = host.endsWith(".") ? host.slice(0, -1) : host;
  if (!raw || raw.includes(":")) return null;
  const parts = raw.split(".");
  if (parts.length < 1 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    const value = parsePart(part);
    if (value === null) return null;
    nums.push(value);
  }
  const lastBytes = 4 - (nums.length - 1);
  const last = nums[nums.length - 1]!;
  const lastMax = 2 ** (8 * lastBytes) - 1;
  if (last > lastMax) return null;
  let ip = 0;
  for (let i = 0; i < nums.length - 1; i++) {
    const value = nums[i]!;
    if (value > 255) return null;
    ip = ip * 256 + value;
  }
  ip = ip * 2 ** (8 * lastBytes) + last;
  if (ip < 0 || ip > 0xffffffff) return null;
  return ip >>> 0;
}

export function dottedIPv4(ip: number): string {
  return `${(ip >>> 24) & 255}.${(ip >>> 16) & 255}.${(ip >>> 8) & 255}.${ip & 255}`;
}

export function ipv4Blocked(ip: number): boolean {
  const a = (ip >>> 24) & 255;
  const b = (ip >>> 16) & 255;
  const c = (ip >>> 8) & 255;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

export function parseIPv6(host: string): bigint | null {
  let value = host.trim().toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  const zone = value.indexOf("%");
  if (zone >= 0) value = value.slice(0, zone);
  if (!value.includes(":")) return null;

  let v4: number | null = null;
  const lastColon = value.lastIndexOf(":");
  const tail = value.slice(lastColon + 1);
  if (tail.includes(".")) {
    v4 = parseIPv4(tail);
    if (v4 === null) return null;
    value = value.slice(0, lastColon);
  }

  const halves = value.split("::");
  if (halves.length > 2) return null;
  const parseSide = (side: string): string[] | null => {
    if (side === "") return [];
    const groups = side.split(":");
    if (groups.some((group) => group.length === 0)) return null;
    return groups;
  };
  const left = parseSide(halves[0] ?? "");
  const right = halves.length === 2 ? parseSide(halves[1] ?? "") : [];
  if (!left || !right) return null;
  const need = v4 === null ? 8 : 6;
  if (halves.length === 1 && left.length !== need) return null;
  if (halves.length === 2 && left.length + right.length > need) return null;
  const zeros = halves.length === 2 ? need - left.length - right.length : 0;
  const groups = [...left, ...Array.from({ length: zeros }, () => "0"), ...right];
  if (groups.length !== need) return null;
  const nums: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    nums.push(Number.parseInt(group, 16));
  }
  if (v4 !== null) nums.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
  if (nums.length !== 8) return null;
  let out = 0n;
  for (const num of nums) out = (out << 16n) + BigInt(num);
  return out;
}

export function ipv6Blocked(ip: bigint): boolean {
  if (ip < 0n || ip > (1n << 128n) - 1n) return true;
  // ::/96 includes unspecified, loopback, and deprecated IPv4-compatible forms.
  if (ip >> 32n === 0n) return true;
  // IPv4-mapped ::ffff:0:0/96. The whole prefix is blocked; it is an alternate spelling of an IPv4 address.
  if (ip >> 32n === 0xffffn) return true;
  // NAT64 well-known prefix 64:ff9b::/96. The low 32 bits are the real target.
  if (ip >> 32n === 0x64ff9b0000000000000000n) return ipv4Blocked(Number(ip & 0xffffffffn));
  // Local-use NAT64 64:ff9b:1::/48.
  if (ip >> 80n === 0x0064ff9b0001n) return ipv4Blocked(Number(ip & 0xffffffffn));
  const top7 = Number(ip >> 121n);
  if (top7 === 0x7e) return true;
  const top8 = Number(ip >> 120n);
  if (top8 === 0xff) return true;
  const top10 = Number(ip >> 118n);
  if (top10 === 0x3fa || top10 === 0x3fb) return true;
  if (ip >> 64n === 0x0100000000000000n) return true;
  const top32 = ip >> 96n;
  if (top32 === 0x20010db8n || top32 === 0x20010000n) return true;
  if (ip >> 112n === 0x2002n) return ipv4Blocked(Number((ip >> 80n) & 0xffffffffn));
  return false;
}

/** True when the text is a blocked IP, false when it is a public IP, null when it is not an IP. */
export function addressBlocked(host: string): boolean | null {
  const v4 = parseIPv4(host);
  if (v4 !== null) return ipv4Blocked(v4);
  const v6 = parseIPv6(host);
  if (v6 !== null) return ipv6Blocked(v6);
  return null;
}

export function isBlockedIp(host: string): boolean {
  return addressBlocked(host) === true;
}

function internalHostname(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  if (!name || BLOCKED_HOSTS.has(name)) return true;
  if (name.endsWith(".localhost") || name.endsWith(".local") || name.endsWith(".localdomain")) return true;
  if (name.endsWith(".internal") || name.endsWith(".cluster.local")) return true;
  if (!name.includes(".")) return true;
  return false;
}

function urlFail(message: string): Decision {
  return fail("url", message);
}

/** Synchronous policy: scheme, userinfo, port, hostname, and IP literals. No DNS. */
export function assessUrl(raw: string): Decision {
  const text = raw.trim();
  if (!text || text.length > 2000) return urlFail("Enter an http or https URL.");
  if (/[\u0000-\u0020\\]/.test(text)) return urlFail("That URL is not allowed.");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return urlFail("That URL could not be parsed.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return urlFail("Only http and https URLs are allowed.");
  if (url.username || url.password) return urlFail("URLs with a username or password are not allowed.");
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return urlFail("That URL has no hostname.");
  const blocked = addressBlocked(host);
  if (blocked === true) return fail("ssrf", "That address is in a blocked range.");
  if (blocked === null && internalHostname(host)) return fail("ssrf", "That hostname is not a public site.");
  if (blocked === false && parseIPv4(host) !== null) {
    const ip = parseIPv4(host)!;
    url.hostname = dottedIPv4(ip);
  }
  if (url.port && url.port !== "80" && url.port !== "443") return urlFail("Only ports 80 and 443 are allowed.");
  return { ok: true, url: url.href };
}

export async function authorizeNavigation(raw: string, lookup: Lookup): Promise<Decision> {
  const assessed = assessUrl(raw);
  if (!assessed.ok) return assessed;
  const url = new URL(assessed.url);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (addressBlocked(host) !== null) return assessed;
  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch {
    return fail("dns", "The hostname could not be resolved.");
  }
  if (addresses.length === 0) return fail("dns", "The hostname did not resolve.");
  for (const address of addresses) {
    if (addressBlocked(address) !== false) return fail("ssrf", "DNS for that hostname includes a blocked address.");
  }
  return assessed;
}

/** Every hop is resolved again. A later private answer is a redirect rebinding. */
export async function authorizeChain(urls: string[], lookup: Lookup): Promise<Decision> {
  if (urls.length === 0) return fail("url", "Enter an http or https URL.");
  let last: Decision = fail("url", "Enter an http or https URL.");
  for (const url of urls) {
    last = await authorizeNavigation(url, lookup);
    if (!last.ok) return last;
  }
  return last;
}

type DohResponse = { Answer?: { type?: number; data?: string }[] };

export async function cloudflareDoh(hostname: string): Promise<string[]> {
  const addresses: string[] = [];
  for (const type of ["A", "AAAA"] as const) {
    const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) throw new Error(`DoH ${type} returned ${response.status}`);
    const data = (await response.json()) as DohResponse;
    for (const answer of data.Answer ?? []) {
      if ((answer.type === 1 || answer.type === 28) && answer.data) addresses.push(answer.data);
    }
  }
  return addresses;
}
