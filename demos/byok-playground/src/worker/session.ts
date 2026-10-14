import { SESSION_COOKIE } from "../shared/limits";
import { HttpError } from "./errors";

const SESSION_RE = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([a-f0-9]{32})\\.([a-f0-9]{64})(?:;|$)`);

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function signSession(id: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`byok-playground-session-v1:${id}`));
  return hex(sig);
}

export function readSessionParts(request: Request): { id: string; mac: string } | null {
  const match = (request.headers.get("cookie") ?? "").match(SESSION_RE);
  if (!match?.[1] || !match[2]) return null;
  return { id: match[1], mac: match[2] };
}

export function mintSessionId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

export function sessionCookie(id: string, mac: string, request: Request): string {
  const secure = new URL(request.url).protocol === "https:";
  const flags = ["HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=604800"];
  if (secure) flags.push("Secure");
  return `${SESSION_COOKIE}=${id}.${mac}; ${flags.join("; ")}`;
}

export async function mintSignedSession(env: Env, request: Request): Promise<{ id: string; cookie: string }> {
  const secret = env.SESSION_SECRET?.trim();
  if (!secret) throw new HttpError(503, "session_unconfigured", "Proxy calls are off until SESSION_SECRET is set.");
  const id = mintSessionId();
  const mac = await signSession(id, secret);
  return { id, cookie: sessionCookie(id, mac, request) };
}

export function finish(response: Response, cookie: string | null): Response {
  if (!cookie) return response;
  const headers = new Headers(response.headers);
  headers.append("set-cookie", cookie);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function requireSession(request: Request, env: Env): Promise<string> {
  const secret = env.SESSION_SECRET?.trim();
  if (!secret) throw new HttpError(503, "session_unconfigured", "Proxy calls are off until SESSION_SECRET is set.");
  const parts = readSessionParts(request);
  if (!parts) throw new HttpError(401, "session", "Complete the Turnstile check once so this browser can call your endpoint.");
  const expected = await signSession(parts.id, secret);
  if (!timingSafeEqual(parts.mac, expected)) {
    throw new HttpError(401, "session", "Complete the Turnstile check once so this browser can call your endpoint.");
  }
  return parts.id;
}
