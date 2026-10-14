import { SESSION_COOKIE } from "../shared/limits";
import { HttpError } from "./errors";

const SESSION_RE = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([a-f0-9]{32})(?:;|$)`);

export function readSessionId(request: Request): string | null {
  const match = (request.headers.get("cookie") ?? "").match(SESSION_RE);
  return match?.[1] ?? null;
}

export function mintSessionId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

export function sessionCookie(id: string, request: Request): string {
  const secure = new URL(request.url).protocol === "https:";
  const flags = ["HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=604800"];
  if (secure) flags.push("Secure");
  return `${SESSION_COOKIE}=${id}; ${flags.join("; ")}`;
}

export function visitor(request: Request): { id: string; cookie: string | null } {
  const existing = readSessionId(request);
  if (existing) return { id: existing, cookie: null };
  const id = mintSessionId();
  return { id, cookie: sessionCookie(id, request) };
}

export function finish(response: Response, cookie: string | null): Response {
  if (!cookie) return response;
  const headers = new Headers(response.headers);
  headers.append("set-cookie", cookie);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function requireSession(request: Request): string {
  const id = readSessionId(request);
  if (!id) throw new HttpError(401, "session", "Load this page first. Proxy calls need the session cookie.");
  return id;
}
