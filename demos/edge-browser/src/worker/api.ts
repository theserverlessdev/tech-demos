import { z } from "zod";
import { LIMITS } from "../shared/limits";
import type { CaptureListItem, CaptureView, SessionPayload } from "../shared/types";
import { countRecent, countRecentIp, countSince, deleteCaptureRow, getCapture, insertCapture, listCaptures, listExpiredIds, markError, objectKey, toView, type CaptureRow } from "./db";
import { budgetDecision, hashIpKey, networkKey } from "./policy";
import { authorizeNavigation, assessUrl, cloudflareDoh } from "./ssrf";
import { turnstileConfigured, verifyTurnstile } from "./turnstile";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const COOKIE = "eb_vid";
const VISITOR = /^[a-f0-9]{32}$/;
const CAPTURE_ID = /^[a-f0-9]{32}$/;

const TurnstileSchema = z.string().trim().min(1).max(2048);
const UrlSchema = z.string().trim().min(1).max(LIMITS.maxUrlLength);

const FILES = {
  desktop: { names: ["desktop.png", "desktop.jpg"] as const, type: "image/png" },
  phone: { names: ["phone.png", "phone.jpg"] as const, type: "image/png" },
  pdf: { names: ["page.pdf"] as const, type: "application/pdf" },
};

function json(data: unknown, status = 200, extra?: Headers): Response {
  const headers = extra ?? new Headers();
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { status, headers });
}

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") || "local";
}

function readVisitor(request: Request): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) {
      let value = "";
      try {
        value = decodeURIComponent(rest.join("="));
      } catch {
        return null;
      }
      return VISITOR.test(value) ? value : null;
    }
  }
  return null;
}

function cookiePath(url: URL): string {
  return url.pathname.startsWith("/demos/edge-browser") ? "/demos/edge-browser" : "/";
}

function visitorCookie(url: URL, visitorId: string): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${visitorId}; HttpOnly; SameSite=Lax; Path=${cookiePath(url)}; Max-Age=604800${secure}`;
}

function ensureVisitor(request: Request): { id: string; fresh: boolean } {
  const existing = readVisitor(request);
  if (existing) return { id: existing, fresh: false };
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return { id: [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(""), fresh: true };
}

function withVisitor(request: Request, response: Response, visitor: { id: string; fresh: boolean }): Response {
  if (!visitor.fresh) return response;
  const headers = new Headers(response.headers);
  headers.append("set-cookie", visitorCookie(new URL(request.url), visitor.id));
  return new Response(response.body, { status: response.status, headers });
}

function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) return;
  if (origin !== new URL(request.url).origin) throw new HttpError(403, "origin", "Origin not allowed.");
}

async function limit(binding: RateLimit, request: Request, message: string, key = networkKey(clientIp(request))): Promise<void> {
  const { success } = await binding.limit({ key });
  if (!success) throw new HttpError(429, "rate_limited", message);
}

async function readBody(request: Request): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isFinite(size) || size < 0 || size > 8_000) throw new HttpError(413, "too_large", "The request body is too large.");
  }
  const text = await request.text();
  if (text.length > 8_000) throw new HttpError(413, "too_large", "The request body is too large.");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "bad_json", "The request body must be JSON.");
  }
}

function field(body: unknown, key: string): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  return (body as Record<string, unknown>)[key];
}

function publicSiteKey(env: Env): string | null {
  const key = env.TURNSTILE_SITE_KEY?.trim() ?? "";
  if (!key || key === "REPLACE_ME") return null;
  return key;
}

function newId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function reconcile(env: Env, row: CaptureRow): Promise<CaptureRow> {
  if (row.status === "complete" || row.status === "error") return row;
  try {
    const instance = await env.CAPTURE.get(row.id);
    const status = await instance.status();
    if (status.status === "errored" || status.status === "terminated") {
      const message = "error" in status && status.error && typeof status.error.message === "string" ? status.error.message : "The capture stopped.";
      await markError(env, row.id, null, message);
      return (await getCapture(env, row.id)) ?? row;
    }
  } catch (err) {
    console.error(JSON.stringify({ event: "workflow_status_failed", error: String(err).slice(0, 200) }));
  }
  return row;
}

function listItem(row: CaptureRow): CaptureListItem {
  return { id: row.id, url: row.url, title: row.title, status: row.status, createdAt: row.created_at, expiresAt: row.expires_at };
}

function owned(row: CaptureRow | null, visitorId: string): CaptureRow {
  if (!row || row.visitor_id !== visitorId) throw new HttpError(404, "not_found", "That capture does not exist.");
  return row;
}

async function fileResponse(env: Env, id: string, kind: keyof typeof FILES): Promise<Response> {
  const file = FILES[kind];
  let object: R2ObjectBody | null = null;
  for (const name of file.names) {
    object = await env.BUCKET.get(objectKey(id, name));
    if (object) break;
  }
  if (!object) throw new HttpError(404, "not_found", "That file is not ready.");
  const headers = new Headers();
  headers.set("content-type", object.httpMetadata?.contentType || file.type);
  headers.set("cache-control", "private, max-age=3600");
  headers.set("x-content-type-options", "nosniff");
  headers.set("cross-origin-resource-policy", "same-origin");
  headers.set("x-robots-tag", "noindex");
  headers.set("content-security-policy", "sandbox; default-src 'none'");
  if (kind === "pdf") headers.set("content-disposition", "attachment; filename=\"page.pdf\"");
  return new Response(object.body, { headers });
}

export async function cleanupExpired(env: Env): Promise<{ captures: number; objects: number }> {
  let captures = 0;
  let objects = 0;
  for (let batch = 0; batch < 5; batch++) {
    const ids = await listExpiredIds(env, Date.now());
    if (ids.length === 0) break;
    for (const id of ids) {
      try {
        const listed = await env.BUCKET.list({ prefix: `captures/${id}/` });
        const keys = listed.objects.map((object) => object.key);
        if (keys.length > 0) await env.BUCKET.delete(keys);
        objects += keys.length;
      } catch (err) {
        console.error(JSON.stringify({ event: "cleanup_object_failed", id, error: String(err).slice(0, 200) }));
        continue;
      }
      await deleteCaptureRow(env, id);
      captures += 1;
    }
    if (ids.length < 40) break;
  }
  return { captures, objects };
}

export async function handleApi(request: Request, env: Env, path: string): Promise<Response> {
  const url = new URL(request.url);
  const visitor = ensureVisitor(request);

  if (request.method === "GET" && path === "/api/health") {
    let d1 = false;
    try {
      await env.DB.prepare("SELECT 1 AS ok").first();
      d1 = true;
    } catch (err) {
      console.error(JSON.stringify({ event: "d1_unavailable", error: String(err).slice(0, 200) }));
    }
    const environment: string = env.ENVIRONMENT;
    return withVisitor(request, json({ ok: d1, d1, turnstile: turnstileConfigured(env), browser: environment === "local" ? "stub" : "binding" }), visitor);
  }

  if (request.method === "GET" && path === "/api/session") {
    await limit(env.READ_LIMIT, request, "Too many reads from this address. Wait a minute.");
    const since = Date.now() - 60 * 60 * 1000;
    const ipKey = await hashIpKey(clientIp(request));
    const [capturesUsed, networkUsed] = await Promise.all([countRecent(env, visitor.id, since), countRecentIp(env, ipKey, since)]);
    const payload: SessionPayload = {
      siteKey: publicSiteKey(env),
      capturesPerHour: LIMITS.capturesPerHour,
      capturesUsed,
      networkUsed,
      dailyCap: LIMITS.dailyCap,
      retentionHours: 24,
    };
    return withVisitor(request, json(payload), visitor);
  }

  if (request.method === "GET" && path === "/api/captures") {
    await limit(env.READ_LIMIT, request, "Too many reads from this address. Wait a minute.");
    const rows = await listCaptures(env, visitor.id);
    return withVisitor(request, json({ captures: rows.map(listItem) }), visitor);
  }

  const fileMatch = /^\/api\/captures\/([a-f0-9]{32})\/(desktop|phone|pdf)$/.exec(path);
  if (request.method === "GET" && fileMatch) {
    await limit(env.READ_LIMIT, request, "Too many reads from this address. Wait a minute.");
    const id = fileMatch[1] ?? "";
    const kind = fileMatch[2] as keyof typeof FILES;
    owned(await getCapture(env, id), visitor.id);
    return withVisitor(request, await fileResponse(env, id, kind), visitor);
  }

  const oneMatch = /^\/api\/captures\/([a-f0-9]{32})$/.exec(path);
  if (request.method === "GET" && oneMatch) {
    await limit(env.READ_LIMIT, request, "Too many reads from this address. Wait a minute.");
    const id = oneMatch[1] ?? "";
    const row = owned(await getCapture(env, id), visitor.id);
    const current = await reconcile(env, row);
    const view: CaptureView = await toView(env, current);
    return withVisitor(request, json(view), visitor);
  }

  if (request.method === "POST" && path === "/api/captures") {
    assertSameOrigin(request);
    if (!turnstileConfigured(env)) throw new HttpError(503, "turnstile_unconfigured", "Turnstile is not configured. Set TURNSTILE_SECRET.");
    const body = await readBody(request);
    const token = TurnstileSchema.safeParse(field(body, "turnstileToken"));
    if (!token.success) throw new HttpError(400, "turnstile_required", "Complete the Turnstile check first.");
    const urlField = UrlSchema.safeParse(field(body, "url"));
    if (!urlField.success) throw new HttpError(400, "url", "Enter an http or https URL.");
    const assessed = assessUrl(urlField.data);
    if (!assessed.ok) throw new HttpError(400, assessed.code, assessed.message);
    await limit(env.CAPTURE_LIMIT, request, "Too many captures from this network. Wait a minute.");
    if (!(await verifyTurnstile(env, request, token.data))) {
      throw new HttpError(403, "turnstile_failed", "Turnstile did not pass. Try the check again.");
    }
    const now = Date.now();
    const ipKey = await hashIpKey(clientIp(request));
    const [cookieUsed, networkUsed, dailyUsed] = await Promise.all([
      countRecent(env, visitor.id, now - 60 * 60 * 1000),
      countRecentIp(env, ipKey, now - 60 * 60 * 1000),
      countSince(env, now - LIMITS.retentionMs),
    ]);
    const budget = budgetDecision({ cookie: cookieUsed, network: networkUsed, daily: dailyUsed });
    if (!budget.ok) throw new HttpError(budget.status, budget.code, budget.message);
    const decision = await authorizeNavigation(assessed.url, cloudflareDoh);
    if (!decision.ok) throw new HttpError(400, decision.code, decision.message);
    const id = newId();
    if (!CAPTURE_ID.test(id)) throw new HttpError(500, "internal", "The server failed. Try again.");
    await insertCapture(env, { id, visitorId: visitor.id, ipKey, url: decision.url, now });
    try {
      await env.CAPTURE.create({ id, params: { captureId: id, visitorId: visitor.id } });
    } catch (err) {
      console.error(JSON.stringify({ event: "workflow_create_failed", error: String(err).slice(0, 300) }));
      await markError(env, id, "Check the URL", "The capture could not be started.");
      throw new HttpError(503, "workflow", "The capture could not be started.");
    }
    return withVisitor(request, json({ id, url: decision.url }, 201), visitor);
  }

  throw new HttpError(404, "not_found", "That API path does not exist.");
}
