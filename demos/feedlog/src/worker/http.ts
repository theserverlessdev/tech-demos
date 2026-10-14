import { MAX_JSON_BYTES } from "./limits";

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

export function declaredLength(request: Request): number | null {
  const raw = request.headers.get("content-length");
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
  return n;
}

export function requireDeclaredLength(request: Request, max: number): number {
  const n = declaredLength(request);
  if (n === null) throw new HttpError(411, "length_required", "Content-Length is required.");
  if (n > max) throw new HttpError(413, "too_large", "The request body is too large.");
  return n;
}

export async function readCappedBytes(request: Request, max: number): Promise<Uint8Array> {
  requireDeclaredLength(request, max);
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, "too_large", "The request body is too large.");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function readJson(request: Request, max = MAX_JSON_BYTES): Promise<Record<string, unknown>> {
  const bytes = await readCappedBytes(request, max);
  const text = new TextDecoder().decode(bytes);
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

export async function readForm(request: Request, max: number): Promise<FormData> {
  const bytes = await readCappedBytes(request, max);
  return new Request(request.url, { method: "POST", headers: request.headers, body: bytes }).formData();
}

/** Reject browser cross-site writes. Missing Sec-Fetch-Site / Origin stays allowed (smoke, curl). */
export function requireSameSite(request: Request): void {
  const site = (request.headers.get("sec-fetch-site") ?? "").toLowerCase();
  if (site === "cross-site") throw new HttpError(403, "cross_site", "This action has to come from the board.");
  const origin = request.headers.get("origin");
  if (!origin) return;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new HttpError(403, "cross_site", "This action has to come from the board.");
  }
  if (originHost !== new URL(request.url).host) {
    throw new HttpError(403, "cross_site", "This action has to come from the board.");
  }
}

export function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const FORMAT_AND_CONTROL = /[\p{Cc}\p{Cf}]+/gu;

export function stripControls(value: string): string {
  return value.replace(FORMAT_AND_CONTROL, "").replace(/\s+/g, " ").trim();
}

export function cleanLine(value: unknown, min: number, max: number, label: string): string {
  if (typeof value !== "string") throw new HttpError(400, "invalid", `${label} is required.`);
  const text = stripControls(value);
  if (text.length < min) throw new HttpError(400, "invalid", `${label} is too short.`);
  if (text.length > max) throw new HttpError(400, "invalid", `${label} is too long.`);
  return text;
}

export function displayName(value: unknown): string {
  if (value === undefined || value === null || value === "") return "Visitor";
  if (typeof value !== "string") throw new HttpError(400, "invalid", "Display name must be text.");
  const name = stripControls(value).slice(0, 40);
  if (!name) return "Visitor";
  if (name.includes("@")) throw new HttpError(400, "invalid", "Use a display name, not an email address.");
  return name;
}

export function isLoopback(request: Request): boolean {
  const host = new URL(request.url).hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}
