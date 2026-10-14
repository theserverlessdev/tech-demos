import { ALLOWED_SUFFIXES, LIMITS, type AllowedSuffix } from "../shared/limits";
import { HttpError } from "./errors";

export type Lookup = (hostname: string) => Promise<string[]>;

export type Decision = { ok: true; url: string } | { ok: false; code: "ssrf" | "dns" | "url"; message: string };

export type AssessOptions = {
  /** Only when Env.ENVIRONMENT === "local". Allows http://localhost, http://127.0.0.1, and http://[::1]. */
  allowLocalhost?: boolean;
};

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

export function ipv4Loopback(ip: number): boolean {
  return ((ip >>> 24) & 255) === 127;
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
  if (a === 192 && b === 88 && c === 99) return true;
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

export function ipv6Loopback(ip: bigint): boolean {
  return ip === 1n;
}

function ipv6Prefix(ip: bigint, bits: number): bigint {
  return ip >> BigInt(128 - bits);
}

export function ipv6Blocked(ip: bigint): boolean {
  if (ip < 0n || ip > (1n << 128n) - 1n) return true;
  if (ip >> 32n === 0n) return true;
  if (ip >> 32n === 0xffffn) return true;
  if (ip >> 32n === 0xffff0000n) return true;
  if (ip >> 32n === 0x64ff9b0000000000000000n) return ipv4Blocked(Number(ip & 0xffffffffn));
  if (ipv6Prefix(ip, 48) === 0x64ff9b0001n) return true;
  if (ipv6Prefix(ip, 20) === 0x3fff0n) return true;
  if (ipv6Prefix(ip, 16) === 0x5f00n) return true;
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

function isLocalhostName(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (name === "localhost" || name === "localhost.localdomain") return true;
  const v4 = parseIPv4(name);
  if (v4 !== null) return ipv4Loopback(v4);
  const v6 = parseIPv6(name);
  if (v6 !== null) return ipv6Loopback(v6);
  return false;
}

export function internalHostname(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  if (!name || BLOCKED_HOSTS.has(name)) return true;
  if (name.endsWith(".localhost") || name.endsWith(".local") || name.endsWith(".localdomain")) return true;
  if (name.endsWith(".internal") || name.endsWith(".cluster.local")) return true;
  if (name === "arpa" || name.endsWith(".arpa")) return true;
  if (name === "lan" || name.endsWith(".lan")) return true;
  if (name === "intranet" || name.endsWith(".intranet")) return true;
  if (name === "corp" || name.endsWith(".corp")) return true;
  if (name === "svc" || name.endsWith(".svc")) return true;
  if (name === "home.arpa" || name.endsWith(".home.arpa")) return true;
  if (name === "theserverless.dev" || name.endsWith(".theserverless.dev")) return true;
  if (name === "workers.dev" || name.endsWith(".workers.dev")) return true;
  if (!name.includes(".")) return true;
  return false;
}

function urlFail(message: string): Decision {
  return fail("url", message);
}

/** Synchronous policy: scheme, userinfo, port, hostname, and IP literals. No DNS. */
export function assessUrl(raw: string, options: AssessOptions = {}): Decision {
  const text = raw.trim();
  if (!text || text.length > LIMITS.maxBaseUrlChars) return urlFail("Enter an https base URL.");
  if (/[\u0000-\u0020\\]/.test(text)) return urlFail("That URL is not allowed.");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return urlFail("That URL could not be parsed.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return urlFail("That URL has no hostname.");
  const localOk = Boolean(options.allowLocalhost) && isLocalhostName(host);

  if (url.protocol === "http:") {
    if (!localOk) return urlFail("Only https URLs are allowed.");
  } else if (url.protocol !== "https:") {
    return urlFail("Only https URLs are allowed.");
  }
  if (url.username || url.password) return urlFail("URLs with a username or password are not allowed.");

  const blocked = addressBlocked(host);
  if (blocked !== null) {
    if (localOk) {
      /* loopback literals are allowed only under ENVIRONMENT=local */
    } else {
      return fail("ssrf", "IP address literals are not allowed. Use a hostname.");
    }
  }
  if (blocked === null && internalHostname(host) && !localOk) return fail("ssrf", "That hostname is not a public site.");
  if (!localOk && url.port && url.port !== "443") return urlFail("Only port 443 is allowed.");
  return { ok: true, url: url.href };
}

export async function authorizeNavigation(raw: string, lookup: Lookup, options: AssessOptions = {}): Promise<Decision> {
  const assessed = assessUrl(raw, options);
  if (!assessed.ok) return assessed;
  const url = new URL(assessed.url);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (options.allowLocalhost && isLocalhostName(host)) return assessed;
  if (addressBlocked(host) !== null) return assessed;
  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch {
    return fail("dns", "The hostname could not be resolved. DNS is best-effort; platform egress is the backstop.");
  }
  if (addresses.length === 0) return fail("dns", "The hostname did not resolve. DNS is best-effort; platform egress is the backstop.");
  for (const address of addresses) {
    if (addressBlocked(address) !== false) return fail("ssrf", "DNS for that hostname includes a blocked address.");
  }
  return assessed;
}

type DohResponse = { Answer?: { type?: number; data?: string }[] };

export async function cloudflareDoh(hostname: string): Promise<string[]> {
  const responses = await Promise.all(
    (["A", "AAAA"] as const).map(async (type) => {
      const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`, {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(4_000),
      });
      if (!response.ok) throw new Error(`DoH ${type} returned ${response.status}`);
      return (await response.json()) as DohResponse;
    }),
  );
  const addresses: string[] = [];
  for (const data of responses) {
    for (const answer of data.Answer ?? []) {
      if ((answer.type === 1 || answer.type === 28) && answer.data) addresses.push(answer.data);
    }
  }
  return addresses;
}

/** Join a visitor base URL with /chat/completions or /models. Rejects traversal off the base. */
export function joinAllowedPath(baseUrl: string, suffix: AllowedSuffix): string {
  if (!(ALLOWED_SUFFIXES as readonly string[]).includes(suffix)) {
    throw new HttpError(400, "path", "That path is not allowed.");
  }
  const base = new URL(baseUrl);
  const directory = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  const joined = new URL(suffix.slice(1), `${base.origin}${directory}${base.search}`);
  if (joined.origin !== base.origin) throw new HttpError(400, "path", "That path is not allowed.");
  const root = directory.replace(/\/$/, "") || "";
  if (root && !joined.pathname.startsWith(`${root}/`)) {
    throw new HttpError(400, "path", "That path is not allowed.");
  }
  if (joined.pathname.includes("/../") || joined.pathname.includes("/./")) {
    throw new HttpError(400, "path", "That path is not allowed.");
  }
  return joined.href;
}

export function decisionToError(decision: Exclude<Decision, { ok: true }>): HttpError {
  const status = decision.code === "dns" ? 502 : 400;
  return new HttpError(status, decision.code, decision.message);
}
