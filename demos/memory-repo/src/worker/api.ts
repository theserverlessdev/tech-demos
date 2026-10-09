import { getAgentByName } from "agents";
import { z } from "zod";
import type { ChatMessage, ChatResult, CommitDetail, DreamView, SessionPayload, StatePayload } from "../shared/types";
import { ChatAgent } from "./chat-agent";
import { getVisitor, listExpired, type VisitorRow } from "./db";
import { artifactsBinding, type DemoEnv } from "./env";
import { MemoryAgent, type Snapshot } from "./memory-agent";
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

const COOKIE = "mr_vid";
const VISITOR = /^[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{40}$/;

const TurnstileSchema = z.string().trim().min(1).max(2048);
const MessageSchema = z.string().trim().min(1).max(800);

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
      const value = decodeURIComponent(rest.join("="));
      return VISITOR.test(value) ? value : null;
    }
  }
  return null;
}

function cookiePath(url: URL): string {
  return url.pathname.startsWith("/demos/memory-repo") ? "/demos/memory-repo" : "/";
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

async function limit(binding: RateLimit, request: Request, message: string): Promise<void> {
  const { success } = await binding.limit({ key: clientIp(request) });
  if (!success) throw new HttpError(429, "rate_limited", message);
}

async function readBody(request: Request): Promise<unknown> {
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

function publicSiteKey(env: DemoEnv): string | null {
  const key = env.TURNSTILE_SITE_KEY?.trim() ?? "";
  if (!key || key === "REPLACE_ME") return null;
  return key;
}

function ttlHours(env: DemoEnv): number {
  const hours = Number(env.VISITOR_TTL_HOURS);
  return Number.isFinite(hours) && hours >= 1 && hours <= 168 ? hours : 24;
}

async function memoryStub(env: DemoEnv, visitorId: string) {
  return getAgentByName<Env, MemoryAgent>(env.MemoryAgent, visitorId);
}

async function chatStub(env: DemoEnv, visitorId: string) {
  return getAgentByName<Env, ChatAgent>(env.ChatAgent, `chat-${visitorId}`);
}

async function requireVisitor(env: DemoEnv, visitorId: string): Promise<VisitorRow> {
  const row = await getVisitor(env, visitorId, Date.now());
  if (!row) throw new HttpError(404, "not_ready", "Open a memory repo first.");
  return row;
}

export async function handleApi(request: Request, env: DemoEnv, path: string): Promise<Response> {
  const visitor = ensureVisitor(request);
  const response = await route(request, env, path, visitor.id);
  return withVisitor(request, response, visitor);
}

async function route(request: Request, env: DemoEnv, path: string, visitorId: string): Promise<Response> {
  if (request.method === "GET" && path === "/api/health") return health(env);
  if (request.method === "GET" && path === "/api/session") {
    await limit(env.READ_LIMIT, request, "Too many reads from this address. Wait a minute.");
    return session(env, visitorId);
  }
  if (request.method === "POST" && path === "/api/repo") return openRepo(request, env, visitorId);
  if (request.method === "GET" && path === "/api/state") return state(request, env, visitorId);
  if (request.method === "POST" && path === "/api/chat") return chat(request, env, visitorId);
  if (request.method === "POST" && path === "/api/dream") return dream(request, env, visitorId);

  const commit = /^\/api\/commits\/([a-f0-9]{40})$/.exec(path);
  if (commit && request.method === "GET") return commitDiff(request, env, visitorId, commit[1] ?? "");
  if (commit) throw new HttpError(405, "method", "Use GET for a commit diff.");
  throw new HttpError(404, "not_found", "Unknown API path.");
}

async function health(env: DemoEnv): Promise<Response> {
  let d1 = false;
  try {
    await env.DB.prepare("SELECT 1 AS ok").first();
    d1 = true;
  } catch {
    d1 = false;
  }
  let artifacts: "ok" | "unavailable" = "unavailable";
  const binding = artifactsBinding(env);
  if (binding) {
    try {
      await binding.list({ limit: 1 });
      artifacts = "ok";
    } catch {
      artifacts = "unavailable";
    }
  }
  return json({ ok: d1, d1, artifacts, turnstile: turnstileConfigured(env) });
}

async function session(env: DemoEnv, visitorId: string): Promise<Response> {
  const row = await getVisitor(env, visitorId, Date.now());
  const payload: SessionPayload = {
    siteKey: publicSiteKey(env),
    ttlHours: ttlHours(env),
    ready: Boolean(row),
    expiresAt: row?.expiresAt ?? null,
    repoName: row?.repoName ?? null,
  };
  return json(payload);
}

async function openRepo(request: Request, env: DemoEnv, visitorId: string): Promise<Response> {
  assertSameOrigin(request);
  await limit(env.CREATE_LIMIT, request, "Too many memory repos from this address. Wait a minute.");
  if (!turnstileConfigured(env)) {
    throw new HttpError(503, "turnstile_unconfigured", "Turnstile is not configured. Set TURNSTILE_SECRET.");
  }
  const body = await readBody(request);
  const token = TurnstileSchema.safeParse(field(body, "turnstileToken"));
  if (!token.success) throw new HttpError(400, "turnstile_required", "Complete the Turnstile check first.");
  const ok = await verifyTurnstile(env, request, token.data);
  if (!ok) throw new HttpError(403, "turnstile_failed", "Turnstile did not pass. Try the check again.");

  const existing = await getVisitor(env, visitorId, Date.now());
  if (existing) {
    const payload: SessionPayload = {
      siteKey: publicSiteKey(env),
      ttlHours: ttlHours(env),
      ready: true,
      expiresAt: existing.expiresAt,
      repoName: existing.repoName,
    };
    return json(payload);
  }

  const memory = await memoryStub(env, visitorId);
  const created = await memory.provision();
  if (!created.ok) throw new HttpError(502, created.code, created.message);
  const payload: SessionPayload = {
    siteKey: publicSiteKey(env),
    ttlHours: ttlHours(env),
    ready: true,
    expiresAt: created.expiresAt,
    repoName: created.repoName,
  };
  return json(payload, 201);
}

async function state(request: Request, env: DemoEnv, visitorId: string): Promise<Response> {
  await limit(env.READ_LIMIT, request, "Too many reads from this address. Wait a minute.");
  await requireVisitor(env, visitorId);
  const memory = await memoryStub(env, visitorId);
  const chatAgent = await chatStub(env, visitorId);
  let snapshot: Snapshot;
  let messages: ChatMessage[];
  try {
    snapshot = await memory.snapshot();
    messages = await chatAgent.transcript();
  } catch (err) {
    throw new HttpError(502, "artifacts", err instanceof Error ? err.message : "The memory repo could not be read.");
  }
  const payload: StatePayload = { ...snapshot, messages };
  return json(payload);
}

async function chat(request: Request, env: DemoEnv, visitorId: string): Promise<Response> {
  assertSameOrigin(request);
  await limit(env.CHAT_LIMIT, request, "Too many messages from this address. Wait a minute.");
  await requireVisitor(env, visitorId);
  const body = await readBody(request);
  const message = MessageSchema.safeParse(field(body, "message"));
  if (!message.success) throw new HttpError(400, "bad_message", "Write a message, up to 800 characters.");
  const chatAgent = await chatStub(env, visitorId);
  try {
    const result: ChatResult = await chatAgent.turn({ visitorId, message: message.data });
    return json(result);
  } catch (err) {
    const text = err instanceof Error ? err.message : "The chat turn failed.";
    const status = text.includes("Workers AI") ? 503 : 502;
    throw new HttpError(status, "chat", text);
  }
}

async function dream(request: Request, env: DemoEnv, visitorId: string): Promise<Response> {
  assertSameOrigin(request);
  await limit(env.DREAM_LIMIT, request, "Too many dreams from this address. Wait a minute.");
  await requireVisitor(env, visitorId);
  const memory = await memoryStub(env, visitorId);
  let result: DreamView;
  try {
    result = await memory.runDream("now");
  } catch (err) {
    throw new HttpError(502, "dream", err instanceof Error ? err.message : "The dream failed.");
  }
  return json(result);
}

async function commitDiff(request: Request, env: DemoEnv, visitorId: string, hash: string): Promise<Response> {
  await limit(env.READ_LIMIT, request, "Too many reads from this address. Wait a minute.");
  if (!HASH.test(hash)) throw new HttpError(400, "bad_hash", "That commit hash is invalid.");
  await requireVisitor(env, visitorId);
  const memory = await memoryStub(env, visitorId);
  try {
    const detail: CommitDetail = await memory.diff(hash);
    return json(detail);
  } catch (err) {
    throw new HttpError(404, "not_found", err instanceof Error ? err.message : "That commit is not in this repo.");
  }
}

export async function cleanupExpired(env: DemoEnv): Promise<{ deleted: number }> {
  const rows = await listExpired(env, Date.now(), 20);
  let deleted = 0;
  for (const row of rows) {
    try {
      const memory = await memoryStub(env, row.id);
      await memory.forcePurge();
      try {
        const chatAgent = await chatStub(env, row.id);
        await chatAgent.purge();
      } catch (err) {
        console.error(JSON.stringify({ event: "cleanup_chat_failed", error: String(err).slice(0, 160) }));
      }
      deleted += 1;
    } catch (err) {
      console.error(JSON.stringify({ event: "cleanup_visitor_failed", error: String(err).slice(0, 180) }));
    }
  }
  return { deleted };
}
