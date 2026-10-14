import type { GateAgent } from "./agent";
import { listDecisions, purgeExpired, sessionIsLive } from "./audit";
import { isLocalMode, isTestSiteKey, resolveTurnstileSecret, verifyTurnstile } from "./turnstile";
import { TOOL_NAMES } from "./tools";
import { cookieHeader, legacySessionId, newSessionId, readCookie, sessionKey, sessionTtlSeconds, signSession, verifySession } from "./session";
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

function requireSessionKey(env: Env): string {
  const key = sessionKey(env);
  if (!key) throw new HttpError(503, "session_unconfigured", "Chat is off until SESSION_KEY is set.");
  return key;
}

async function signedCookie(env: Env, id: string, base: string, secure: boolean): Promise<string> {
  const ttl = sessionTtlSeconds(env.SESSION_TTL_SECONDS);
  const exp = Math.floor(Date.now() / 1000) + ttl;
  return cookieHeader(await signSession(requireSessionKey(env), id, exp), base, secure, ttl);
}

function clearCookie(base: string, secure: boolean): string {
  return cookieHeader("", base, secure, 0, true);
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(length) && length > 8_000) throw new HttpError(413, "too_large", "The request body is too large.");
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

function assertOrigin(request: Request, env: Env): void {
  const origin = request.headers.get("origin");
  if (!origin) return;
  const url = new URL(request.url);
  if (origin === url.origin) return;
  if (origin === "https://tech-demos.theserverless.dev" || origin === "https://clef-gate.tech-demos.theserverless.dev") return;
  if (isLocalMode(env) && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return;
  throw new HttpError(403, "origin", "Origin not allowed.");
}

async function limit(binding: RateLimit, request: Request): Promise<void> {
  const { success } = await binding.limit({ key: clientIp(request) });
  if (!success) throw new HttpError(429, "rate_limited", "Too many requests from this address. Wait a minute.");
}

async function requireTurnstile(request: Request, env: Env, body: Record<string, unknown>): Promise<void> {
  const url = new URL(request.url);
  const resolved = resolveTurnstileSecret(isLocalMode(env), env.TURNSTILE_SECRET);
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
  extra?: { status?: number; headers?: HeadersInit },
): Response {
  if (!result.ok) {
    return json({ error: { code: result.code, message: result.message } }, result.status, extra?.headers);
  }
  return json(result.view, extra?.status ?? 200, extra?.headers);
}

function requestFlags(request: Request, env: Env): { forceHeuristic: boolean; forceLocalPlanner: boolean; allowHeuristic: boolean } {
  const local = isLocalMode(env);
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

export type PathLimit = "none" | "session" | "chat" | "read";

/** Rate-limit bucket for a route. Cookie lookup and D1 reads run only after this, except health/config. */
export function pathLimit(method: string, pathname: string): PathLimit {
  if (method === "GET" && (pathname === "/api/health" || pathname === "/api/config")) return "none";
  if (method === "POST" && pathname === "/api/sessions") return "session";
  if (method === "POST" && pathname === "/api/chat") return "chat";
  if (method === "PATCH" && pathname === "/api/model") return "chat";
  if (method === "POST" && pathname === "/api/approvals") return "chat";
  return "read";
}

async function applyPathLimit(env: Env, request: Request, method: string, pathname: string): Promise<void> {
  const kind = pathLimit(method, pathname);
  if (kind === "session") return limit(env.SESSION_LIMIT, request);
  if (kind === "chat") return limit(env.CHAT_LIMIT, request);
  if (kind === "read") return limit(env.READ_LIMIT, request);
}

async function reclaimMissing(env: Env, id: string): Promise<void> {
  try {
    await stub(env, id).reclaim();
  } catch (err) {
    console.error(JSON.stringify({ event: "reclaim_failed", error: err instanceof Error ? err.message : "error" }));
  }
}

type ResolvedSession = { sessionId: string | null; stale: boolean };

async function resolveSession(request: Request, env: Env): Promise<ResolvedSession> {
  const key = sessionKey(env);
  const raw = readCookie(request);
  if (!raw) return { sessionId: null, stale: false };
  if (!key) return { sessionId: null, stale: true };

  const verified = await verifySession(key, raw);
  if (verified) {
    if (await sessionIsLive(env.DB, verified)) return { sessionId: verified, stale: false };
    await reclaimMissing(env, verified);
    return { sessionId: null, stale: true };
  }

  const legacy = legacySessionId(raw);
  if (legacy) {
    if (!(await sessionIsLive(env.DB, legacy))) await reclaimMissing(env, legacy);
    return { sessionId: null, stale: true };
  }

  return { sessionId: null, stale: true };
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

  if (method === "POST" || method === "PATCH" || method === "DELETE") assertOrigin(request, env);

  if (pathname === "/api/sessions" && method === "POST") {
    await applyPathLimit(env, request, method, pathname);
    const body = await readJson(request);
    await requireTurnstile(request, env, body);
    requireSessionKey(env);
    const id = newSessionId();
    const model = parseModel(body.model) ?? "clef";
    const result = await stub(env, id).start({ sessionId: id, model });
    const headers = result.ok ? { "set-cookie": await signedCookie(env, id, base, secure) } : undefined;
    return agentHttp(result, { status: 201, headers });
  }

  await applyPathLimit(env, request, method, pathname);
  const { sessionId, stale } = await resolveSession(request, env);
  const dropStale = stale ? { "set-cookie": clearCookie(base, secure) } : undefined;

  if (pathname === "/api/session" && method === "DELETE") {
    if (sessionId) await stub(env, sessionId).forget();
    return json({ ok: true }, 200, { "set-cookie": clearCookie(base, secure) });
  }

  if (pathname === "/api/chat" && method === "POST") {
    const body = await readJson(request);
    await requireTurnstile(request, env, body);
    const text = typeof body.text === "string" ? body.text : "";
    let id = sessionId;
    let created = false;
    if (!id) {
      await limit(env.SESSION_LIMIT, request);
      requireSessionKey(env);
      id = newSessionId();
      const model = parseModel(body.model) ?? "clef";
      const started = await stub(env, id).start({ sessionId: id, model });
      if (!started.ok) return agentHttp(started, { headers: dropStale });
      created = true;
    }
    const result = await stub(env, id).chat({ text, flags: requestFlags(request, env) });
    const headers = created ? { "set-cookie": await signedCookie(env, id, base, secure) } : dropStale;
    return agentHttp(result, { headers });
  }

  if (!sessionId) {
    if (pathname === "/api/session" && method === "GET") return json({ fresh: true }, 200, dropStale);
    if (pathname === "/api/audit" && method === "GET") return json({ decisions: [] }, 200, dropStale);
    throw new HttpError(401, "no_session", "Start a session before using the desk.");
  }

  if (pathname === "/api/session" && method === "GET") {
    const result = await stub(env, sessionId).view();
    const headers = !result.ok && result.status === 410 ? { "set-cookie": clearCookie(base, secure) } : undefined;
    return agentHttp(result, { headers });
  }

  if (pathname === "/api/audit" && method === "GET") {
    const decisions = await listDecisions(env.DB, sessionId);
    return json({ decisions });
  }

  if (pathname === "/api/model" && method === "PATCH") {
    const body = await readJson(request);
    const model = parseModel(body.model);
    if (!model) throw new HttpError(400, "bad_model", "Model must be clef or clef-flash.");
    return agentHttp(await stub(env, sessionId).setModel(model));
  }

  if (pathname === "/api/approvals" && method === "POST") {
    const body = await readJson(request);
    await requireTurnstile(request, env, body);
    const id = typeof body.id === "string" ? body.id : "";
    const outcome = body.outcome === "approve" || body.outcome === "deny" ? body.outcome : null;
    if (!/^pend_[a-f0-9]{16}$/.test(id) || !outcome) throw new HttpError(400, "bad_approval", "Send the pending id and approve or deny.");
    return agentHttp(await stub(env, sessionId).resolve({ id, outcome, flags: requestFlags(request, env) }));
  }

  throw new HttpError(404, "not_found", "No such API route.");
}

export async function purge(env: Env): Promise<void> {
  await purgeExpired(env.DB);
}
