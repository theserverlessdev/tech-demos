import type { Session } from "../shared/types";
import { BASE_PATH, HttpError } from "./http";

export const COOKIE = "edgechat_sid";
const SESSION_TTL = 60 * 60 * 24 * 30;

export type SessionRecord = {
  id: string;
  publicId: string;
  displayName: string;
  createdAt: number;
};

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

export function sessionCookie(id: string, request: Request): string {
  const url = new URL(request.url);
  const path = url.pathname.startsWith(BASE_PATH) ? BASE_PATH : "/";
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${encodeURIComponent(id)}; Path=${path}; Max-Age=${SESSION_TTL}; SameSite=Lax; HttpOnly${secure}`;
}

export function sanitizeName(raw: unknown): string {
  const text = typeof raw === "string" ? raw : "";
  const cleaned = text.replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 32);
  if (!cleaned) return `Guest-${crypto.randomUUID().slice(0, 4)}`;
  if (cleaned.toLowerCase() === "edgechat") return `Guest-${crypto.randomUUID().slice(0, 4)}`;
  return cleaned;
}

export function publicSession(record: SessionRecord, persisted: boolean): Session {
  return {
    publicId: record.publicId,
    displayName: record.displayName,
    createdAt: record.createdAt,
    persisted,
  };
}

export function ephemeralSession(): Session {
  return {
    publicId: crypto.randomUUID(),
    displayName: sanitizeName(""),
    createdAt: Date.now(),
    persisted: false,
  };
}

/** Cookie only. Incoming x-edgechat-session is ignored. */
export async function loadSession(env: Env, request: Request): Promise<SessionRecord | null> {
  const id = parseCookie(request.headers.get("cookie"), COOKIE);
  if (!id || id.length > 80) return null;
  const raw = await env.SESSIONS.get(kvKey(id), "json");
  if (!raw || typeof raw !== "object") return null;
  const data = raw as { publicId?: unknown; displayName?: unknown; createdAt?: unknown };
  if (typeof data.displayName !== "string" || typeof data.createdAt !== "number") return null;
  const publicId = typeof data.publicId === "string" && data.publicId ? data.publicId : crypto.randomUUID();
  const record: SessionRecord = { id, publicId, displayName: data.displayName, createdAt: data.createdAt };
  if (typeof data.publicId !== "string" || !data.publicId) {
    await env.SESSIONS.put(kvKey(id), JSON.stringify(record), { expirationTtl: SESSION_TTL });
  }
  return record;
}

export async function saveSession(env: Env, record: SessionRecord): Promise<SessionRecord> {
  await env.SESSIONS.put(kvKey(record.id), JSON.stringify(record), { expirationTtl: SESSION_TTL });
  return record;
}

export async function persistSession(env: Env, request: Request, displayName: string): Promise<SessionRecord> {
  const existing = await loadSession(env, request);
  const record: SessionRecord = {
    id: existing?.id ?? crypto.randomUUID(),
    publicId: existing?.publicId ?? crypto.randomUUID(),
    displayName,
    createdAt: existing?.createdAt ?? Date.now(),
  };
  return saveSession(env, record);
}

export async function requirePersistedSession(env: Env, request: Request): Promise<SessionRecord> {
  const existing = await loadSession(env, request);
  if (!existing) throw new HttpError(401, "need_session", "Complete the check to get a session, then try again.");
  return existing;
}
