import { COLUMNS, LIMITS, type ColumnId } from "../shared/types";
import { HttpError } from "./errors";

const TITLE = LIMITS.maxTitle;
const DESCRIPTION = LIMITS.maxDescription;

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") || "local";
}

function originHostOf(request: Request): string | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  try {
    return new URL(origin).host;
  } catch {
    throw new HttpError(403, "origin", "Cross-origin writes are refused.");
  }
}

export function assertSameOrigin(request: Request): void {
  const originHost = originHostOf(request);
  if (!originHost) return;
  if (originHost !== new URL(request.url).host) throw new HttpError(403, "origin", "Cross-origin writes are refused.");
}

export function assertLiveOrigin(request: Request): void {
  const originHost = originHostOf(request);
  if (!originHost || originHost !== new URL(request.url).host) {
    throw new HttpError(403, "origin", "Live sockets need a matching Origin.");
  }
}

export function requireContentLength(request: Request, max: number, kind: "json" | "upload"): number {
  const raw = request.headers.get("content-length");
  if (raw === null || raw === "") {
    throw new HttpError(411, "length_required", kind === "upload" ? "Uploads must send Content-Length." : "JSON bodies must send Content-Length.");
  }
  const length = Number(raw);
  if (!Number.isFinite(length) || length < 0 || length > max) {
    throw new HttpError(413, "too_large", kind === "upload" ? "Files must be 256 KB or smaller." : "The request body is too large.");
  }
  return length;
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  requireContentLength(request, LIMITS.maxJsonBytes, "json");
  const text = await request.text();
  if (text.length > LIMITS.maxJsonBytes) throw new HttpError(413, "too_large", "The request body is too large.");
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

export function parseTitle(value: unknown, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") throw new HttpError(400, "invalid", "Title must be text.");
  const title = value.trim().replace(/\s+/g, " ");
  if (!title) throw new HttpError(400, "invalid", "Title is required.");
  if (title.length > TITLE) throw new HttpError(400, "invalid", `Title must be ${TITLE} characters or fewer.`);
  return title;
}

export function parseDescription(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new HttpError(400, "invalid", "Description must be text.");
  const description = value.trim();
  if (description.length > DESCRIPTION) throw new HttpError(400, "invalid", `Description must be ${DESCRIPTION} characters or fewer.`);
  return description;
}

export function parseColumn(value: unknown): ColumnId | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && (COLUMNS as readonly string[]).includes(value)) return value as ColumnId;
  throw new HttpError(400, "invalid", "Column must be todo, doing, or done.");
}

export function parseIndex(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > LIMITS.maxTasksPerBoard) {
    throw new HttpError(400, "invalid", "Position is invalid.");
  }
  return value;
}

/** Epoch ms from the client (local end of day) or YYYY-MM-DD as that calendar day in UTC. */
export function parseDue(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const due = Math.trunc(value);
    if (due < Date.UTC(2000, 0, 1) || due > Date.UTC(2100, 0, 1)) throw new HttpError(400, "invalid", "Due date is out of range.");
    return due;
  }
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    if (!year || !month || !day) throw new HttpError(400, "invalid", "Due date is invalid.");
    const due = Date.UTC(year, month - 1, day, 23, 59, 59);
    if (Number.isNaN(due)) throw new HttpError(400, "invalid", "Due date is invalid.");
    return due;
  }
  throw new HttpError(400, "invalid", "Due date must be a timestamp or YYYY-MM-DD.");
}

export function parseTtlMs(allowShort: boolean, value: unknown): number {
  if (value === undefined) return LIMITS.boardTtlMs;
  if (!allowShort) throw new HttpError(400, "invalid", "Board lifetime is fixed on this host.");
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 86_400) {
    throw new HttpError(400, "invalid", "ttlSeconds is invalid.");
  }
  return Math.trunc(value * 1000);
}

const SAFE_NAME = /[^A-Za-z0-9._-]+/g;

export function safeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop()?.replace(SAFE_NAME, "_").replace(/^\.+/, "") ?? "";
  const trimmed = base.slice(0, 120);
  return trimmed || "file";
}

export async function enforceLimit(limiter: RateLimit, key: string): Promise<void> {
  const { success } = await limiter.limit({ key });
  if (!success) throw new HttpError(429, "rate_limited", "Too many requests from this address. Wait a minute.");
}
