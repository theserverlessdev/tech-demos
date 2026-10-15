export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const BASE_PATH = "/demos/edgechat";

const ALLOWED_ORIGINS = [
  "https://tech-demos.theserverless.dev",
  "https://edgechat.tech-demos.theserverless.dev",
  "https://tech-demos-edgechat.theserverlessdev.workers.dev",
];

export function isAllowedOrigin(origin: string | null, url: URL): boolean {
  if (!origin) return true;
  if (origin === url.origin || ALLOWED_ORIGINS.includes(origin)) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

export function isLoopback(request: Request): boolean {
  return isLoopbackHost(new URL(request.url).hostname);
}

export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

export function json(data: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set("cache-control", "no-store");
  if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { status, headers });
}

export function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, "bad_path", "That path is not valid.");
  }
}

export function assertContentLength(request: Request, max: number): void {
  const raw = request.headers.get("content-length");
  if (raw == null) return;
  const n = Number(raw);
  if (Number.isFinite(n) && n > max) throw new HttpError(413, "too_large", "The request body is too large.");
}

export function stripEdgechatHeaders(headers: Headers): Headers {
  const next = new Headers(headers);
  for (const key of [...next.keys()]) {
    if (key.toLowerCase().startsWith("x-edgechat-")) next.delete(key);
  }
  return next;
}

export function headerPathStartsWithBase(request: Request): boolean {
  return new URL(request.url).pathname.startsWith(BASE_PATH);
}
