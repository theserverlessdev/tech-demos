export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function json(data: unknown, status = 200, extra?: Headers): Response {
  const headers = extra ?? new Headers();
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return Response.json(data, { status, headers });
}

export function clientKey(request: Request): string {
  return request.headers.get("cf-connecting-ip") || "local";
}

type Limiter = { limit(options: { key: string }): Promise<{ success: boolean }> };

/** Fail closed. A missing limiter must not turn into an open write path. */
export async function enforceLimit(limiter: Limiter, request: Request, message: string): Promise<void> {
  let success = false;
  try {
    success = (await limiter.limit({ key: clientKey(request) })).success;
  } catch (err) {
    console.error(JSON.stringify({ event: "rate_limit_error", error: String(err) }));
    throw new HttpError(429, "rate_limited", "Rate limit is unavailable. Try again shortly.");
  }
  if (!success) throw new HttpError(429, "rate_limited", message);
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > 32_000) throw new HttpError(413, "too_large", "The request body is too large.");
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "invalid_json", "The request body must be JSON.");
  }
}

export function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function cleanLine(value: unknown, min: number, max: number, label: string): string {
  if (typeof value !== "string") throw new HttpError(400, "invalid", `${label} is required.`);
  const text = value.replace(/\u0000/g, "").trim();
  if (text.length < min) throw new HttpError(400, "invalid", `${label} is too short.`);
  if (text.length > max) throw new HttpError(400, "invalid", `${label} is too long.`);
  return text;
}

export function displayName(value: unknown): string {
  if (value === undefined || value === null || value === "") return "Visitor";
  if (typeof value !== "string") throw new HttpError(400, "invalid", "Display name must be text.");
  const name = value.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 40);
  if (!name) return "Visitor";
  if (name.includes("@")) throw new HttpError(400, "invalid", "Use a display name, not an email address.");
  return name;
}

export function isLoopback(request: Request): boolean {
  const host = new URL(request.url).hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}
