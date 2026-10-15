import { getAgentByName } from "agents";
import type { ConfigResponse, HealthResponse, SessionInfo } from "../shared/types";
import { Assistant, type Fail, type Ok } from "./assistant";
import { enforceLimit } from "./limits";
import { ALLOWED_HOSTS, validatePublicUrl } from "./research";
import { turnstileConfigured, verifyTurnstile, type GateFailure } from "./turnstile";
import { hmacSecret, parseVisitorId, signVisitor, verifyVisitorToken } from "./visitor";

export { Assistant };

const BASE_PATH = "/demos/personal-agent";
const NOTE_ID = /^[a-z0-9]{8,32}$/;
const MAX_BODY = 48_000;

const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self' https://challenges.cloudflare.com https://cloudflareinsights.com",
  "frame-src https://challenges.cloudflare.com",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

function failure(gate: GateFailure | Fail, status?: number): Response {
  const code = gate.code;
  const http = status ?? ("status" in gate ? gate.status : statusFor(code));
  return json({ error: { code, message: gate.message } }, http);
}

function statusFor(code: string): number {
  if (code === "not_found") return 404;
  if (code === "too_large") return 413;
  if (code === "too_many_notes") return 409;
  if (code === "fetch_failed" || code === "store_failed") return 502;
  return 400;
}

function ttlHours(env: Env): number {
  return Number(env.VISITOR_TTL_HOURS) || 24;
}

function emptySession(env: Env): SessionInfo {
  return { expiresAt: 0, noteCount: 0, messageCount: 0, ttlHours: ttlHours(env) };
}

async function fromAgent<T extends object>(env: Env, id: string, result: Ok<T> | Fail): Promise<Response> {
  if (!result.ok) return failure(result);
  const secret = hmacSecret(env);
  const visitorToken = secret ? await signVisitor(secret, id) : undefined;
  return json(visitorToken ? { ...result.data, visitorToken } : result.data);
}

async function readJson(request: Request, max = MAX_BODY): Promise<Record<string, unknown> | Response> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) {
    return json({ error: { code: "too_large", message: "The request body is too large." } }, 413);
  }
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!type.startsWith("application/json")) {
    return json({ error: { code: "invalid_json", message: "The request body must be JSON." } }, 415);
  }
  if (!request.body) return json({ error: { code: "invalid_json", message: "The request body must be JSON." } }, 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return json({ error: { code: "too_large", message: "The request body is too large." } }, 413);
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(buf);
  if (!text.trim()) return json({ error: { code: "invalid_json", message: "The request body must be JSON." } }, 400);
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return json({ error: { code: "invalid_json", message: "The request body must be a JSON object." } }, 400);
    }
    return parsed as Record<string, unknown>;
  } catch {
    return json({ error: { code: "invalid_json", message: "The request body must be JSON." } }, 400);
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function urlsFrom(value: unknown): string[] | Response {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length < 2 || value.length > 4) {
    return json({ error: { code: "bad_urls", message: "Provide 2 to 4 https URLs, or omit urls to use the docs catalog." } }, 400);
  }
  const urls: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length > 500) {
      return json({ error: { code: "bad_urls", message: "Each research URL must be a short string." } }, 400);
    }
    const checked = validatePublicUrl(item);
    if (!checked.ok) return failure(checked);
    urls.push(checked.url.toString());
  }
  return urls;
}

async function serveAsset(request: Request, env: Env, path: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const assetUrl = new URL(request.url);
  assetUrl.pathname = path === "/" ? "/index.html" : path;
  let res = await env.ASSETS.fetch(new Request(assetUrl, { method: request.method, headers: request.headers }));
  if (res.status === 404 && !path.startsWith("/assets/")) {
    assetUrl.pathname = "/index.html";
    res = await env.ASSETS.fetch(new Request(assetUrl, { method: request.method, headers: request.headers }));
  }
  const headers = new Headers(res.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  if ((headers.get("content-type") ?? "").startsWith("text/html")) headers.set("content-security-policy", PAGE_CSP);
  return new Response(res.body, { status: res.status, headers });
}

async function assistantFor(env: Env, id: string): Promise<DurableObjectStub<Assistant>> {
  return getAgentByName<Env, Assistant>(env.ASSISTANT, id);
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    let path = url.pathname;
    if (path === BASE_PATH) {
      url.pathname = `${BASE_PATH}/`;
      return Response.redirect(url.toString(), 308);
    }
    if (path.startsWith(`${BASE_PATH}/`)) path = path.slice(BASE_PATH.length);

    try {
      if (path.startsWith("/api/")) return await handleApi(request, env, path);
    } catch (err) {
      console.error(JSON.stringify({ event: "api_error", error: err instanceof Error ? err.name : "error" }));
      return json({ error: { code: "internal", message: "The server failed. Try again." } }, 500);
    }
    return serveAsset(request, env, path);
  },
} satisfies ExportedHandler<Env>;

async function handleApi(request: Request, env: Env, path: string): Promise<Response> {
  if (path === "/api/health" && request.method === "GET") {
    const body: HealthResponse = {
      ok: true,
      model: env.AI_MODEL,
      embedModel: env.EMBED_MODEL,
      turnstile: turnstileConfigured(env) ? "configured" : "missing",
    };
    return json(body);
  }

  if (path === "/api/config" && request.method === "GET") {
    const body: ConfigResponse = {
      siteKey: env.TURNSTILE_SITE_KEY?.trim() ?? "",
      ttlHours: ttlHours(env),
      model: env.AI_MODEL,
      embedModel: env.EMBED_MODEL,
      allowlist: ALLOWED_HOSTS,
    };
    return json(body);
  }

  const noteMatch = path.match(/^\/api\/notes\/([a-z0-9]{8,32})$/);

  if (request.method === "GET") {
    const known = path === "/api/session" || path === "/api/thread" || path === "/api/notes" || Boolean(noteMatch);
    if (!known) return json({ error: { code: "not_found", message: "Unknown API path." } }, 404);
    const limited = await enforceLimit(env.READ_LIMIT, request);
    if (!limited.ok) return failure(limited);
    const secret = hmacSecret(env);
    const id = secret ? await verifyVisitorToken(secret, request.headers.get("x-visitor-id")) : null;
    if (!id) {
      if (noteMatch) return json({ error: { code: "not_found", message: "That note is not in this visitor's notebook." } }, 404);
      if (path === "/api/session") return json(emptySession(env));
      if (path === "/api/thread") return json({ messages: [] });
      return json({ notes: [] });
    }
    const agent = await assistantFor(env, id);
    if (path === "/api/session") return fromAgent(env, id, await agent.session());
    if (path === "/api/thread") return fromAgent(env, id, await agent.thread());
    if (path === "/api/notes") return fromAgent(env, id, await agent.listNotes());
    if (noteMatch && NOTE_ID.test(noteMatch[1]!)) return fromAgent(env, id, await agent.readNote(noteMatch[1]!));
    return json({ error: { code: "not_found", message: "Unknown API path." } }, 404);
  }

  if (request.method === "DELETE" && noteMatch && NOTE_ID.test(noteMatch[1]!)) {
    const body = await readJson(request);
    if (body instanceof Response) return body;
    const gated = await gateWrite(request, env, body, "chat");
    if (gated instanceof Response) return gated;
    const agent = await assistantFor(env, gated);
    return fromAgent(env, gated, await agent.deleteNote(noteMatch[1]!));
  }

  if (request.method !== "POST") return json({ error: { code: "method", message: "Method not allowed." } }, 405);

  const body = await readJson(request);
  if (body instanceof Response) return body;

  if (path === "/api/notes") {
    const gated = await gateWrite(request, env, body, "chat");
    if (gated instanceof Response) return gated;
    const agent = await assistantFor(env, gated);
    return fromAgent(env, gated, await agent.saveNote({ title: asString(body.title), body: asString(body.body) }));
  }

  if (path === "/api/chat") {
    const gated = await gateWrite(request, env, body, "chat");
    if (gated instanceof Response) return gated;
    const agent = await assistantFor(env, gated);
    return fromAgent(env, gated, await agent.chat({ message: asString(body.message) }));
  }

  if (path === "/api/research") {
    const urls = urlsFrom(body.urls);
    if (urls instanceof Response) return urls;
    const question = asString(body.question).trim();
    if (question.length < 8 || question.length > 500) {
      return json({ error: { code: "invalid", message: "The research question must be 8 to 500 characters." } }, 400);
    }
    const gated = await gateWrite(request, env, body, "research");
    if (gated instanceof Response) return gated;
    const agent = await assistantFor(env, gated);
    return fromAgent(env, gated, await agent.research({ question, urls }));
  }

  return json({ error: { code: "not_found", message: "Unknown API path." } }, 404);
}

async function gateWrite(request: Request, env: Env, body: Record<string, unknown>, kind: "chat" | "research"): Promise<string | Response> {
  const id = parseVisitorId(body.visitorId);
  if (!id) return json({ error: { code: "invalid_visitor", message: "A visitor id is required." } }, 400);
  if (!hmacSecret(env)) {
    return json({ error: { code: "visitor_unconfigured", message: "Visitor signing is not configured, so writes are closed." } }, 503);
  }
  const limited = await enforceLimit(kind === "research" ? env.RESEARCH_LIMIT : env.CHAT_LIMIT, request);
  if (!limited.ok) return failure(limited);
  const checked = await verifyTurnstile(env, request, asString(body.turnstileToken));
  if (!checked.ok) return failure(checked);
  return id;
}
