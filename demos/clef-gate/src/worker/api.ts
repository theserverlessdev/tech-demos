import type { GateAgent } from "./agent";
import { listDecisions, purgeExpired } from "./audit";
import { isLocalRequest, isTestSiteKey, resolveTurnstileSecret, verifyTurnstile } from "./turnstile";
import { TOOL_NAMES } from "./tools";
import type { ClefModel, HealthBody, PublicConfig } from "../shared/types";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const COOKIE = "clef_gate";
const TOOL_BLURBS: Record<(typeof TOOL_NAMES)[number], string> = {
  read_docs: "Read a page of demo docs",
  fetch_url: "Describe a public https URL",
  send_email: "Simulate an email",
  delete_record: "Simulate a row delete",
  run_sql: "Simulate one SQL statement",
};

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  const next = new Headers(headers);
  next.set("cache-control", "no-store");
  return Response.json(data, { status, headers: next });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) return json({ error: { code: err.code, message: err.message } }, err.status);
  console.error(JSON.stringify({ event: "api_error", error: err instanceof Error ? err.message : "error" }));
  return json({ error: { code: "internal", message: "The server failed. Try again." } }, 500);
}

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") || "local";
}

function cookieValue(request: Request): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) {
      const value = rest.join("=").trim();
      return /^[a-f0-9]{32}$/.test(value) ? value : null;
    }
  }
  return null;
}

function cookieHeader(id: string, base: string, secure: boolean, clear = false): string {
  const path = base || "/";
  const parts = [`${COOKIE}=${clear ? "" : id}`, "HttpOnly", "SameSite=Lax", `Path=${path}`, `Max-Age=${clear ? 0 : 21600}`];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function newSessionId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > 8_000) throw new HttpError(413, "too_large", "The request body is too large.");
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid_json", "The request body must be JSON.");
  }
}

function parseModel(value: unknown): ClefModel | null {
  return value === "clef" || value === "clef-flash" ? value : null;
}

function assertOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) return;
  const url = new URL(request.url);
  if (origin === url.origin) return;
  if (origin === "https://tech-demos.theserverless.dev" || origin === "https://clef-gate.tech-demos.theserverless.dev") return;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return;
  throw new HttpError(403, "origin", "Origin not allowed.");
}

async function limit(binding: RateLimit, request: Request): Promise<void> {
  const { success } = await binding.limit({ key: clientIp(request) });
  if (!success) throw new HttpError(429, "rate_limited", "Too many requests from this address. Wait a minute.");
}

async function requireTurnstile(request: Request, env: Env, body: Record<string, unknown>): Promise<void> {
  const url = new URL(request.url);
  const hostForPolicy = isLocalRequest(request) ? "127.0.0.1" : url.hostname;
  const resolved = resolveTurnstileSecret(hostForPolicy, env.TURNSTILE_SECRET);
  if (!resolved.ok) {
    throw new HttpError(503, "turnstile_unconfigured", "Chat is off until TURNSTILE_SECRET is set to a real widget secret.");
  }
  const token = typeof body.turnstileToken === "string" ? body.turnstileToken.trim() : "";
  const ok = await verifyTurnstile(resolved.secret, token, clientIp(request), url.hostname);
  if (!ok) throw new HttpError(403, "turnstile_failed", "Turnstile did not pass. Retry the check, then send again.");
}

function stub(env: Env, sessionId: string): DurableObjectStub<GateAgent> {
  return env.GATE.get(env.GATE.idFromName(sessionId));
}

function agentHttp(
  result: Awaited<ReturnType<GateAgent["view"]>>,
  base: string,
  secure: boolean,
  extra?: { status?: number; cookie?: string },
): Response {
  if (!result.ok) {
    const headers = result.status === 410 ? { "set-cookie": cookieHeader("", base, secure, true) } : undefined;
    return json({ error: { code: result.code, message: result.message } }, result.status, headers);
  }
  return json(result.view, extra?.status ?? 200, extra?.cookie ? { "set-cookie": extra.cookie } : undefined);
}

function flags(request: Request): { forceHeuristic: boolean; forceLocalPlanner: boolean; allowHeuristic: boolean } {
  const local = isLocalRequest(request);
  return {
    allowHeuristic: local,
    forceHeuristic: local && request.headers.get("x-clef-source") === "heuristic",
    forceLocalPlanner: local && request.headers.get("x-planner") === "local",
  };
}

function config(env: Env): PublicConfig {
  return {
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || "1x00000000000000000000AA",
    testSiteKey: isTestSiteKey(env.TURNSTILE_SITE_KEY),
    confidenceFloor: Number(env.CONFIDENCE_FLOOR) || 0.62,
    models: [
      { id: "clef", label: "Clef" },
      { id: "clef-flash", label: "Clef-flash" },
    ],
    tools: TOOL_NAMES.map((name) => ({ name, blurb: TOOL_BLURBS[name] })),
  };
}

export async function handleApi(request: Request, env: Env, pathname: string, base: string): Promise<Response> {
  const method = request.method;
  const url = new URL(request.url);
  const secure = url.protocol === "https:";

  if (pathname === "/api/health" && method === "GET") {
    const body: HealthBody = {
      ok: true,
      chatModel: env.CHAT_MODEL,
      clef: env.CLEF_MODEL,
      clefFlash: env.CLEF_FLASH_MODEL,
      siteKeyMode: isTestSiteKey(env.TURNSTILE_SITE_KEY) ? "test" : "custom",
    };
    return json(body);
  }

  if (pathname === "/api/config" && method === "GET") return json(config(env));

  if (method === "POST" || method === "PATCH" || method === "DELETE") assertOrigin(request);

  if (pathname === "/api/sessions" && method === "POST") {
    await limit(env.SESSION_LIMIT, request);
    const body = await readJson(request);
    await requireTurnstile(request, env, body);
    const model = parseModel(body.model) ?? "clef";
    const id = newSessionId();
    const result = await stub(env, id).start({ sessionId: id, model });
    return agentHttp(result, base, secure, { status: 201, cookie: cookieHeader(id, base, secure) });
  }

  const sessionId = cookieValue(request);

  if (pathname === "/api/session" && method === "DELETE") {
    if (sessionId) await stub(env, sessionId).forget();
    return json({ ok: true }, 200, { "set-cookie": cookieHeader("", base, secure, true) });
  }

  if (pathname === "/api/chat" && method === "POST") {
    await limit(env.CHAT_LIMIT, request);
    const body = await readJson(request);
    await requireTurnstile(request, env, body);
    const text = typeof body.text === "string" ? body.text : "";
    let id = sessionId;
    let created = false;
    if (!id) {
      await limit(env.SESSION_LIMIT, request);
      id = newSessionId();
      const model = parseModel(body.model) ?? "clef";
      const started = await stub(env, id).start({ sessionId: id, model });
      if (!started.ok) return agentHttp(started, base, secure);
      created = true;
    }
    const result = await stub(env, id).chat({ text, flags: flags(request) });
    return agentHttp(result, base, secure, created ? { cookie: cookieHeader(id, base, secure) } : undefined);
  }

  if (!sessionId) {
    if (pathname === "/api/session" && method === "GET") return json({ fresh: true });
    if (pathname === "/api/audit" && method === "GET") return json({ decisions: [] });
    throw new HttpError(401, "no_session", "Start a session before using the desk.");
  }

  if (pathname === "/api/session" && method === "GET") {
    return agentHttp(await stub(env, sessionId).view(), base, secure);
  }

  if (pathname === "/api/audit" && method === "GET") {
    const decisions = await listDecisions(env.DB, sessionId);
    return json({ decisions });
  }

  if (pathname === "/api/model" && method === "PATCH") {
    await limit(env.CHAT_LIMIT, request);
    const body = await readJson(request);
    const model = parseModel(body.model);
    if (!model) throw new HttpError(400, "bad_model", "Model must be clef or clef-flash.");
    return agentHttp(await stub(env, sessionId).setModel(model), base, secure);
  }

  if (pathname === "/api/approvals" && method === "POST") {
    await limit(env.CHAT_LIMIT, request);
    const body = await readJson(request);
    await requireTurnstile(request, env, body);
    const id = typeof body.id === "string" ? body.id : "";
    const outcome = body.outcome === "approve" || body.outcome === "deny" ? body.outcome : null;
    if (!/^pend_[a-f0-9]{16}$/.test(id) || !outcome) throw new HttpError(400, "bad_approval", "Send the pending id and approve or deny.");
    return agentHttp(await stub(env, sessionId).resolve({ id, outcome, flags: flags(request) }), base, secure);
  }

  throw new HttpError(404, "not_found", "No such API route.");
}

export async function purge(env: Env): Promise<void> {
  await purgeExpired(env.DB);
}
