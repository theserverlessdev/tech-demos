import type { Session } from "../shared/types";

export const COOKIE = "edgechat_sid";
const SESSION_TTL = 60 * 60 * 24 * 30;

function kvKey(id: string): string {
  return `session:${id}`;
}

export function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [rawKey, ...rest] = part.trim().split("=");
    if (rawKey === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function sessionCookie(id: string): string {
  return `${COOKIE}=${encodeURIComponent(id)}; Path=/; Max-Age=${SESSION_TTL}; SameSite=Lax; HttpOnly`;
}

export function sanitizeName(raw: unknown): string {
  const text = typeof raw === "string" ? raw : "";
  const cleaned = text.replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 32);
  return cleaned || `Guest-${crypto.randomUUID().slice(0, 4)}`;
}

export async function loadSession(env: Env, request: Request): Promise<Session | null> {
  const headerId = request.headers.get("x-edgechat-session");
  const cookieId = parseCookie(request.headers.get("cookie"), COOKIE);
  const id = headerId?.trim() || cookieId;
  if (!id || id.length > 80) return null;
  const raw = await env.SESSIONS.get(kvKey(id), "json");
  if (!raw || typeof raw !== "object") return null;
  const data = raw as { displayName?: unknown; createdAt?: unknown };
  if (typeof data.displayName !== "string" || typeof data.createdAt !== "number") return null;
  return { id, displayName: data.displayName, createdAt: data.createdAt };
}

export async function saveSession(env: Env, id: string, displayName: string, createdAt = Date.now()): Promise<Session> {
  const session: Session = { id, displayName, createdAt };
  await env.SESSIONS.put(kvKey(id), JSON.stringify(session), { expirationTtl: SESSION_TTL });
  return session;
}

export async function requireSession(env: Env, request: Request): Promise<Session> {
  const existing = await loadSession(env, request);
  if (existing) return existing;
  return saveSession(env, crypto.randomUUID(), sanitizeName(""));
}

export async function upsertSession(env: Env, request: Request, displayName: string): Promise<Session> {
  const existing = await loadSession(env, request);
  const id = existing?.id ?? crypto.randomUUID();
  return saveSession(env, id, displayName, existing?.createdAt ?? Date.now());
}
