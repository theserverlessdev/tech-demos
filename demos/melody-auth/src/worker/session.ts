import { readCookie } from "./body";

export const SESSION_COOKIE = "ma_session";
export const HOST_SESSION_COOKIE = "__Host-ma_session";

export function sessionCookieName(request: Request): string {
  const url = new URL(request.url);
  if (url.protocol === "https:" && url.hostname === "melody-auth.tech-demos.theserverless.dev") return HOST_SESSION_COOKIE;
  return SESSION_COOKIE;
}

export function sessionFrom(request: Request): string | null {
  const header = request.headers.get("cookie");
  const url = new URL(request.url);
  if (url.hostname === "melody-auth.tech-demos.theserverless.dev") return readCookie(header, HOST_SESSION_COOKIE);
  return readCookie(header, HOST_SESSION_COOKIE) ?? readCookie(header, SESSION_COOKIE);
}

export function sessionCookie(token: string, request: Request, onHub: boolean, maxAge: number): string {
  const name = sessionCookieName(request);
  const hostCookie = name === HOST_SESSION_COOKIE;
  const path = hostCookie ? "/" : onHub ? "/demos/melody-auth" : "/";
  const secure = hostCookie || new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=${path}; Max-Age=${maxAge}${secure}`;
}

export function clearSessionCookie(request: Request, onHub: boolean): string {
  return sessionCookie("deleted", request, onHub, 0);
}
