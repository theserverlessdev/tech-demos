import { LIMITS, SESSION_COOKIE } from "../shared/limits";
import { networkKey } from "./budget";
import { HttpError } from "./errors";
import { clientIp } from "./origin";

const SESSION_RE = new RegExp(
  `(?:^|;\\s*)${SESSION_COOKIE}=([a-f0-9]{32})\\.(\\d{1,16})\\.([A-Za-z0-9_-]+)\\.([a-f0-9]{64})(?:;|$)`,
);

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function b64url(value: string): string {
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromB64url(value: string): string {
  const pad = "=".repeat((4 - (value.length % 4)) % 4);
  return atob(value.replaceAll("-", "+").replaceAll("_", "/") + pad);
}

async function signSession(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return hex(sig);
}

function sessionPayload(id: string, iat: number, nkey: string): string {
  return `byok-playground-session-v2:${id}:${iat}:${nkey}`;
}

export type SessionParts = { id: string; iat: number; networkKey: string; mac: string };

export function readSessionParts(request: Request): SessionParts | null {
  const match = (request.headers.get("cookie") ?? "").match(SESSION_RE);
  if (!match?.[1] || !match[2] || !match[3] || !match[4]) return null;
  try {
    return { id: match[1], iat: Number(match[2]), networkKey: fromB64url(match[3]), mac: match[4] };
  } catch {
    return null;
  }
}

export function mintSessionId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

export function sessionCookie(id: string, iat: number, nkey: string, mac: string, request: Request): string {
  const secure = new URL(request.url).protocol === "https:";
  const maxAge = Math.floor(LIMITS.sessionTtlMs / 1000);
  const flags = ["HttpOnly", "SameSite=Lax", "Path=/", `Max-Age=${maxAge}`];
  if (secure) flags.push("Secure");
  return `${SESSION_COOKIE}=${id}.${iat}.${b64url(nkey)}.${mac}; ${flags.join("; ")}`;
}

export async function mintSignedSession(env: Env, request: Request, now = Date.now()): Promise<{ id: string; cookie: string }> {
  const secret = env.SESSION_SECRET?.trim();
  if (!secret) throw new HttpError(503, "session_unconfigured", "Proxy calls are off until SESSION_SECRET is set.");
  const id = mintSessionId();
  const iat = Math.floor(now / 1000);
  const nkey = networkKey(clientIp(request));
  const mac = await signSession(sessionPayload(id, iat, nkey), secret);
  return { id, cookie: sessionCookie(id, iat, nkey, mac, request) };
}

export function finish(response: Response, cookie: string | null): Response {
  if (!cookie) return response;
  const headers = new Headers(response.headers);
  headers.append("set-cookie", cookie);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function requireSession(request: Request, env: Env, now = Date.now()): Promise<string> {
  const secret = env.SESSION_SECRET?.trim();
  if (!secret) throw new HttpError(503, "session_unconfigured", "Proxy calls are off until SESSION_SECRET is set.");
  const parts = readSessionParts(request);
  if (!parts) throw new HttpError(401, "session", "Complete the Turnstile check once so this browser can call your endpoint.");
  const expected = await signSession(sessionPayload(parts.id, parts.iat, parts.networkKey), secret);
  if (!timingSafeEqual(parts.mac, expected)) {
    throw new HttpError(401, "session", "Complete the Turnstile check once so this browser can call your endpoint.");
  }
  const ageMs = now - parts.iat * 1000;
  if (ageMs > LIMITS.sessionTtlMs || ageMs < -60_000) {
    throw new HttpError(401, "session_expired", "The session expired. Complete the Turnstile check again.");
  }
  const current = networkKey(clientIp(request));
  if (parts.networkKey !== current) {
    throw new HttpError(401, "session_network", "This network is new. Complete the Turnstile check again.");
  }
  return parts.id;
}
