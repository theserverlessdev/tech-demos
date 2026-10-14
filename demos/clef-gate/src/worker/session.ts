/** Signed anonymous session cookies. Only a verified id may reach idFromName. */

export const COOKIE = "clef_gate";
export const LOCAL_SESSION_KEY = "local-clef-gate-session-key-not-for-prod";

const SESSION_TTL_DEFAULT = 21_600;
const COOKIE_RE = /^([a-f0-9]{32})\.(\d+)\.([a-f0-9]{64})$/;
const LEGACY_ID_RE = /^[a-f0-9]{32}$/;

/** Pre-HMAC cookies were a bare 32-hex session id. Used only to reclaim leftover Durable Objects. */
export function legacySessionId(value: string | null): string | null {
  if (!value || !LEGACY_ID_RE.test(value)) return null;
  return value;
}

export function sessionTtlSeconds(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : SESSION_TTL_DEFAULT;
}

export function isLocalDev(env: { LOCAL_DEV?: string }): boolean {
  return env.LOCAL_DEV === "1";
}

export function sessionKey(env: { SESSION_KEY?: string; LOCAL_DEV?: string }): string | null {
  const key = env.SESSION_KEY?.trim() ?? "";
  if (key) return key;
  if (isLocalDev(env)) return LOCAL_SESSION_KEY;
  return null;
}

function hexFromBytes(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesFromHex(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[a-f0-9]+$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (a: BufferSource, b: BufferSource) => boolean };
  if (typeof subtle.timingSafeEqual === "function") return subtle.timingSafeEqual(left, right);
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hexFromBytes(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))));
}

export async function signSession(secret: string, id: string, expSeconds: number): Promise<string> {
  const payload = `${id}.${expSeconds}`;
  return `${payload}.${await hmacHex(secret, payload)}`;
}

export async function verifySession(secret: string, value: string | null, now = Date.now()): Promise<string | null> {
  if (!value) return null;
  const match = COOKIE_RE.exec(value);
  if (!match) return null;
  const id = match[1] ?? "";
  const exp = Number(match[2]);
  const sig = match[3] ?? "";
  if (!id || !Number.isFinite(exp) || exp * 1000 <= now) return null;
  const expected = await hmacHex(secret, `${id}.${exp}`);
  const left = bytesFromHex(expected);
  const right = bytesFromHex(sig);
  if (!left || !right || left.byteLength !== right.byteLength) return null;
  return timingSafeEqual(left, right) ? id : null;
}

export function readCookie(request: Request): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) {
      const value = rest.join("=").trim();
      return value || null;
    }
  }
  return null;
}

export function cookieHeader(value: string, base: string, secure: boolean, maxAge: number, clear = false): string {
  const path = base || "/";
  const parts = [`${COOKIE}=${clear ? "" : value}`, "HttpOnly", "SameSite=Lax", `Path=${path}`, `Max-Age=${clear ? 0 : maxAge}`];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function newSessionId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

/** True when the approval window has already closed, even if the alarm has not run. */
export function isPendingExpired(expiresAt: number, now = Date.now()): boolean {
  return expiresAt <= now;
}
