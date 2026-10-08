import { z } from "zod";
import type { AppConfig, CreatedOrg, OrgView } from "../shared/types";
import { newId, newToken } from "./secret";
import { verifyTurnstile } from "./turnstile";

export { Org } from "./org";

/** The hub serves this demo under a path. The subdomain serves it at the root. */
const BASE_PATH = "/demos/company-brain";

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

const ORG_ID = /^org_[0-9a-f]{32}$/;

const CreateBody = z.object({ turnstileToken: z.string().trim().min(1).max(2048) });
const ChatBody = z.object({
  message: z.string().trim().min(1).max(500),
  turnstileToken: z.string().trim().min(1).max(2048),
});

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function json(data: unknown, status = 200, extra?: Headers): Response {
  const headers = extra ?? new Headers();
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify(data), { status, headers });
}

function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) return json({ error: { code: err.code, message: err.message } }, err.status);
  console.error(JSON.stringify({ event: "api_error", name: err instanceof Error ? err.name : "error" }));
  return json({ error: { code: "internal", message: "The server failed. Try again." } }, 500);
}

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") || "local";
}

async function limit(binding: RateLimit, key: string): Promise<void> {
  const { success } = await binding.limit({ key });
  if (!success) throw new HttpError(429, "rate_limited", "Too many requests from this address. Wait a minute.");
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? null;
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.trim().indexOf("=");
    if (eq === -1) continue;
    if (part.trim().slice(0, eq) === name) return decodeURIComponent(part.trim().slice(eq + 1));
  }
  return null;
}

function originAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  let host = "";
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  const url = new URL(request.url);
  if (origin === url.origin) return true;
  if (host === "tech-demos.theserverless.dev" || host === "company-brain.tech-demos.theserverless.dev") return true;
  if (/^tech-demos-company-brain\.[a-z0-9-]+\.workers\.dev$/.test(host)) return true;
  return /^localhost$|^127\.0\.0\.1$/.test(host);
}

async function readBounded(request: Request, max: number): Promise<string> {
  const text = await request.text();
  if (text.length > max) throw new HttpError(413, "too_large", "The request body is too large.");
  return text;
}

function parseObject(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid_json", "The request body must be JSON.");
  }
}

function sessionCookie(token: string, request: Request, onHub: boolean): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  const path = onHub ? BASE_PATH : "/";
  const maxAge = 60 * 60 * 24;
  return `cb_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=${path}; Max-Age=${maxAge}${secure}`;
}

async function callOrg(env: Env, orgId: string, pathname: string, method: string, request: Request, body?: string, provision = false): Promise<Response> {
  const headers = new Headers();
  if (body !== undefined) headers.set("content-type", "application/json");
  headers.set("x-org-id", orgId);
  if (provision) headers.set("x-provision", "1");
  const session = bearer(request) ?? readCookie(request.headers.get("cookie"), "cb_session");
  if (session) headers.set("x-session", session);
  const ingest = request.headers.get("x-ingest-token");
  if (ingest && ingest.length <= 200) headers.set("x-ingest-token", ingest);
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  const res = await stub.fetch(new Request(`https://org.internal${pathname}`, { method, headers, body }));
  const out = new Headers(res.headers);
  out.set("cache-control", "no-store");
  out.set("x-content-type-options", "nosniff");
  return new Response(res.body, { status: res.status, headers: out });
}

async function createOrg(request: Request, env: Env, onHub: boolean): Promise<Response> {
  if (!originAllowed(request)) throw new HttpError(403, "origin", "Origin not allowed.");
  await limit(env.CREATE_LIMIT, clientIp(request));
  const parsed = CreateBody.safeParse(parseObject(await readBounded(request, 4_000)));
  if (!parsed.success) throw new HttpError(400, "invalid_body", "A Turnstile token is required.");
  if (!(await verifyTurnstile(env, parsed.data.turnstileToken, request))) {
    throw new HttpError(403, "turnstile_failed", "Turnstile did not pass.");
  }

  const orgId = newId("org");
  const sessionToken = newToken();
  const ingestToken = newToken();
  const headers = new Headers({ "content-type": "application/json", "x-org-id": orgId, "x-provision": "1" });
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  const res = await stub.fetch(new Request("https://org.internal/provision", {
    method: "POST",
    headers,
    body: JSON.stringify({ sessionToken, ingestToken }),
  }));
  if (!res.ok) {
    const out = new Headers(res.headers);
    out.set("cache-control", "no-store");
    return new Response(res.body, { status: res.status, headers: out });
  }

  const view = (await res.json()) as OrgView;
  const created: CreatedOrg = { ...view, id: orgId, sessionToken, ingestToken };
  const responseHeaders = new Headers();
  responseHeaders.append("set-cookie", sessionCookie(sessionToken, request, onHub));
  return json(created, 201, responseHeaders);
}

async function orgRoute(request: Request, env: Env, orgId: string, rest: string): Promise<Response> {
  if (!ORG_ID.test(orgId)) throw new HttpError(400, "invalid_org", "Org id is invalid.");
  if (!originAllowed(request)) throw new HttpError(403, "origin", "Origin not allowed.");
  const ip = clientIp(request);
  const method = request.method;
  const path = rest || "/";

  if (method === "GET" && (path === "/" || path === "/memory")) {
    await limit(env.READ_LIMIT, ip);
    return callOrg(env, orgId, "/memory", "GET", request);
  }

  if (method === "POST" && (path === "/facts" || path === "/decisions" || path === "/ingest")) {
    await limit(env.WRITE_LIMIT, ip);
    const body = await readBounded(request, 8_000);
    parseObject(body);
    return callOrg(env, orgId, path, "POST", request, body);
  }

  if (method === "POST" && path === "/chat") {
    await limit(env.CHAT_LIMIT, ip);
    const parsed = ChatBody.safeParse(parseObject(await readBounded(request, 8_000)));
    if (!parsed.success) throw new HttpError(400, "invalid_body", "Send a message and a Turnstile token.");
    if (!(await verifyTurnstile(env, parsed.data.turnstileToken, request))) {
      throw new HttpError(403, "turnstile_failed", "Turnstile did not pass.");
    }
    return callOrg(env, orgId, "/chat", "POST", request, JSON.stringify({ message: parsed.data.message }));
  }

  throw new HttpError(method === "GET" || method === "POST" ? 404 : 405, "not_found", "Unknown org route.");
}

async function handleApi(request: Request, env: Env, path: string, onHub: boolean): Promise<Response> {
  if (path === "/api/health" && request.method === "GET") return json({ ok: true, model: env.AI_MODEL });
  if (path === "/api/config" && request.method === "GET") {
    const config: AppConfig = {
      turnstileSiteKey: env.TURNSTILE_SITE_KEY,
      model: env.AI_MODEL,
      orgTtlHours: env.ORG_TTL_HOURS,
      turnstileConfigured: Boolean(env.TURNSTILE_SECRET),
    };
    return json(config);
  }
  if (path === "/api/orgs" && request.method === "POST") return createOrg(request, env, onHub);

  const match = /^\/api\/orgs\/([^/]+)(\/[^?]*)?$/.exec(path);
  if (match?.[1]) return orgRoute(request, env, decodeURIComponent(match[1]), match[2] ?? "/");
  throw new HttpError(404, "not_found", "Unknown API route.");
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

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    let path = url.pathname;
    const onHub = path === BASE_PATH || path.startsWith(`${BASE_PATH}/`);

    if (path === BASE_PATH) {
      url.pathname = `${BASE_PATH}/`;
      return Response.redirect(url.toString(), 308);
    }
    if (path.startsWith(`${BASE_PATH}/`)) path = path.slice(BASE_PATH.length) || "/";

    // The agent protocol is not public. Session checks live on these REST routes.
    if (path.startsWith("/api/")) {
      try {
        return await handleApi(request, env, path, onHub);
      } catch (err) {
        return errorResponse(err);
      }
    }

    return serveAsset(request, env, path);
  },
} satisfies ExportedHandler<Env>;
