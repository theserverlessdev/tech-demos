import { getAgentByName } from "agents";
import type { ConfigResponse, HealthResponse } from "../shared/types";
import { Assistant, type Fail, type Ok } from "./assistant";
import { enforceLimit } from "./limits";
import { ALLOWED_HOSTS, validatePublicUrl } from "./research";
import { turnstileConfigured, verifyTurnstile, type GateFailure } from "./turnstile";

export { Assistant };

const BASE_PATH = "/demos/personal-agent";
const VISITOR_ID = /^[a-z0-9]{16,32}$/;
const NOTE_ID = /^[a-z0-9]{8,32}$/;

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

function fromAgent<T>(result: Ok<T> | Fail): Response {
  if (!result.ok) return failure(result);
  return json(result.data);
}

async function readJson(request: Request, max = 48_000): Promise<Record<string, unknown> | Response> {
  const text = await request.text();
  if (text.length > max) return json({ error: { code: "too_large", message: "The request body is too large." } }, 413);
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

function visitorId(value: unknown): string | null {
  return typeof value === "string" && VISITOR_ID.test(value) ? value : null;
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
      ttlHours: Number(env.VISITOR_TTL_HOURS) || 24,
      model: env.AI_MODEL,
      embedModel: env.EMBED_MODEL,
      allowlist: ALLOWED_HOSTS,
    };
    return json(body);
  }

  const noteMatch = path.match(/^\/api\/notes\/([a-z0-9]{8,32})$/);

  if (request.method === "GET") {
    const limited = await enforceLimit(env.READ_LIMIT, request);
    if (!limited.ok) return failure(limited);
    const id = visitorId(new URL(request.url).searchParams.get("visitorId"));
    if (!id) return json({ error: { code: "invalid_visitor", message: "A visitor id is required." } }, 400);
    const agent = await assistantFor(env, id);
    if (path === "/api/session") return fromAgent(await agent.session());
    if (path === "/api/thread") return fromAgent(await agent.thread());
    if (path === "/api/notes") return fromAgent(await agent.listNotes());
    if (noteMatch && NOTE_ID.test(noteMatch[1]!)) return fromAgent(await agent.readNote(noteMatch[1]!));
    return json({ error: { code: "not_found", message: "Unknown API path." } }, 404);
  }

  if (request.method === "DELETE" && noteMatch && NOTE_ID.test(noteMatch[1]!)) {
    const body = await readJson(request);
    if (body instanceof Response) return body;
    const gated = await gateWrite(request, env, body, "chat");
    if (gated instanceof Response) return gated;
    const agent = await assistantFor(env, gated);
    return fromAgent(await agent.deleteNote(noteMatch[1]!));
  }

  if (request.method !== "POST") return json({ error: { code: "method", message: "Method not allowed." } }, 405);

  const body = await readJson(request);
  if (body instanceof Response) return body;

  if (path === "/api/notes") {
    const gated = await gateWrite(request, env, body, "chat");
    if (gated instanceof Response) return gated;
    const agent = await assistantFor(env, gated);
    return fromAgent(await agent.saveNote({ title: asString(body.title), body: asString(body.body) }));
  }

  if (path === "/api/chat") {
    const gated = await gateWrite(request, env, body, "chat");
    if (gated instanceof Response) return gated;
    const agent = await assistantFor(env, gated);
    return fromAgent(await agent.chat({ message: asString(body.message) }));
  }

  if (path === "/api/research") {
    const gated = await gateWrite(request, env, body, "research");
    if (gated instanceof Response) return gated;
    const urls = urlsFrom(body.urls);
    if (urls instanceof Response) return urls;
    const agent = await assistantFor(env, gated);
    return fromAgent(await agent.research({ question: asString(body.question), urls }));
  }

  return json({ error: { code: "not_found", message: "Unknown API path." } }, 404);
}

async function gateWrite(request: Request, env: Env, body: Record<string, unknown>, kind: "chat" | "research"): Promise<string | Response> {
  const id = visitorId(body.visitorId);
  if (!id) return json({ error: { code: "invalid_visitor", message: "A visitor id is required." } }, 400);
  const limited = await enforceLimit(kind === "research" ? env.RESEARCH_LIMIT : env.CHAT_LIMIT, request);
  if (!limited.ok) return failure(limited);
  const checked = await verifyTurnstile(env, request, asString(body.turnstileToken));
  if (!checked.ok) return failure(checked);
  return id;
}
