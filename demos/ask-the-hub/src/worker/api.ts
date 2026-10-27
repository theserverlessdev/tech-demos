import { capMessage, searchCapMessage, type ClaimResult, type TokenDecision } from "./cap";
import { createSearch, searchConfigured, type Chunk } from "./search";
import { devEnabled, tokenHash, verifyTurnstile, type VerifyResult } from "./turnstile";
import { parseQuestion, readToken } from "./validate";
import type { Env } from "./env";

export const HUB_ORIGIN = "https://tech-demos.theserverless.dev";
export const DEMO_ORIGIN = "https://ask-the-hub.tech-demos.theserverless.dev";
export const MAX_BODY = 4096;

const RATE_MESSAGE = "This demo is busy for a moment. Try again shortly.";
const TURNSTILE_MESSAGE = "The check did not pass. Try again.";
const SEARCH_DOWN = "Search is unavailable right now.";

export type Deps = {
  dev: boolean;
  siteKey: string;
  searchReady: boolean;
  limit: (name: "ASK_LIMIT" | "SEARCH_LIMIT", key: string) => Promise<boolean>;
  verify: (token: string, ip: string) => Promise<VerifyResult>;
  takeToken: (hash: string) => Promise<TokenDecision>;
  rememberToken: (hash: string) => Promise<boolean>;
  claim: () => Promise<ClaimResult>;
  claimSearch: () => Promise<ClaimResult>;
  refund: () => Promise<void>;
  refundSearch: () => Promise<void>;
  search: (query: string) => Promise<Chunk[]>;
  aiSearch: (query: string) => Promise<Response>;
};

export function clientIp(request: Request): string {
  const value = request.headers.get("cf-connecting-ip")?.trim() ?? "";
  return value.slice(0, 64) || "unknown";
}

export function allowedOrigin(origin: string, dev: boolean): boolean {
  if (origin === HUB_ORIGIN || origin === DEMO_ORIGIN) return true;
  if (!dev) return false;
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

function corsHeaders(request: Request, dev: boolean): Headers {
  const headers = new Headers();
  const origin = request.headers.get("origin") ?? "";
  if (allowedOrigin(origin, dev)) {
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "origin");
  }
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set("access-control-allow-headers", "content-type");
  headers.set("access-control-max-age", "86400");
  headers.set("x-content-type-options", "nosniff");
  headers.set("cache-control", "no-store");
  headers.set("referrer-policy", "no-referrer");
  return headers;
}

function json(status: number, body: unknown, request: Request, deps: Deps): Response {
  const headers = corsHeaders(request, deps.dev);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers });
}

function isJsonType(value: string): boolean {
  return (value.split(";")[0] ?? "").trim().toLowerCase() === "application/json";
}

async function readJson(request: Request): Promise<unknown> {
  const type = request.headers.get("content-type") ?? "";
  if (!isJsonType(type)) throw new Error("type");
  const declared = request.headers.get("content-length");
  if (declared !== null && (!Number.isFinite(Number(declared)) || Number(declared) > MAX_BODY)) {
    throw new Error("size");
  }
  if (!request.body) return {};
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const step = await reader.read();
    if (step.done) break;
    total += step.value.byteLength;
    if (total > MAX_BODY) {
      await reader.cancel();
      throw new Error("size");
    }
    parts.push(step.value);
  }
  const text = new TextDecoder().decode(concatBytes(parts));
  if (!text) return {};
  return JSON.parse(text) as unknown;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

async function admit(token: string, request: Request, deps: Deps): Promise<VerifyResult> {
  if (!token.trim()) return "missing";
  const hash = await tokenHash(token);
  const cached = await deps.takeToken(hash);
  if (cached === "replay") return "ok";
  if (cached === "spent") return "rejected";
  const verdict = await deps.verify(token, clientIp(request));
  if (verdict !== "ok") return verdict;
  const inserted = await deps.rememberToken(hash);
  if (inserted) return "ok";
  const again = await deps.takeToken(hash);
  return again === "replay" ? "ok" : "rejected";
}

async function release(refund: () => Promise<void>): Promise<void> {
  try {
    await refund();
  } catch {
    // The visitor still sees the search error. The slot may stay used until midnight.
  }
}

export async function handleApi(request: Request, deps: Deps, path: string): Promise<Response | null> {
  if (request.method === "OPTIONS" && (path === "/api/ask" || path === "/api/search" || path === "/api/health" || path === "/api/config")) {
    return new Response(null, { status: 204, headers: corsHeaders(request, deps.dev) });
  }
  if (path === "/api/health" && request.method === "GET") {
    if (!deps.searchReady) return json(503, { ok: false, error: "Search is not configured." }, request, deps);
    return json(200, { ok: true }, request, deps);
  }
  if (path === "/api/config" && request.method === "GET") {
    return json(200, { siteKey: deps.siteKey, dev: deps.dev }, request, deps);
  }
  if (path !== "/api/ask" && path !== "/api/search") return null;
  if (request.method !== "POST") {
    return json(405, { error: "Send a POST.", code: "method" }, request, deps);
  }

  let body: unknown;
  try {
    body = await readJson(request);
  } catch {
    return json(400, { error: "Send a question.", code: "invalid_question" }, request, deps);
  }
  const parsed = parseQuestion(body);
  if (!parsed.ok) return json(400, { error: parsed.error, code: "invalid_question" }, request, deps);

  const limitName = path === "/api/ask" ? "ASK_LIMIT" : "SEARCH_LIMIT";
  const allowed = await deps.limit(limitName, clientIp(request));
  if (!allowed) return json(429, { error: RATE_MESSAGE, code: "rate_limit" }, request, deps);

  const verdict = await admit(readToken(body), request, deps);
  if (verdict !== "ok") {
    return json(403, { error: TURNSTILE_MESSAGE, code: verdict === "missing" ? "missing_token" : "turnstile" }, request, deps);
  }

  if (path === "/api/ask") {
    const claim = await deps.claim();
    if (!claim.ok) {
      return json(429, { error: capMessage(claim.cap), code: "daily_cap", resetsAt: claim.resetsAt }, request, deps);
    }
    let upstream: Response;
    try {
      upstream = await deps.aiSearch(parsed.question);
    } catch {
      await release(deps.refund);
      return json(502, { error: SEARCH_DOWN, code: "search_unavailable" }, request, deps);
    }
    if (!upstream.ok || !upstream.body) {
      await upstream.body?.cancel();
      await release(deps.refund);
      return json(502, { error: SEARCH_DOWN, code: "search_unavailable" }, request, deps);
    }
    const headers = corsHeaders(request, deps.dev);
    headers.set("content-type", upstream.headers.get("content-type") || "text/event-stream; charset=utf-8");
    return new Response(upstream.body, { status: 200, headers });
  }

  const searchClaim = await deps.claimSearch();
  if (!searchClaim.ok) {
    return json(429, { error: searchCapMessage(searchClaim.cap), code: "daily_cap", resetsAt: searchClaim.resetsAt }, request, deps);
  }
  try {
    const chunks = await deps.search(parsed.question);
    return json(200, { chunks }, request, deps);
  } catch {
    await release(deps.refundSearch);
    return json(502, { error: SEARCH_DOWN, code: "search_unavailable" }, request, deps);
  }
}

type CapStub = DurableObjectStub & {
  claim: () => Promise<ClaimResult>;
  claimSearch: () => Promise<ClaimResult>;
  refund: () => Promise<void>;
  refundSearch: () => Promise<void>;
  rememberToken: (hash: string) => Promise<boolean>;
  takeToken: (hash: string) => Promise<TokenDecision>;
};

function stubOf(env: Env): CapStub {
  return env.ASK_CAP.getByName("global") as CapStub;
}

export function depsFromEnv(env: Env): Deps {
  const dev = devEnabled(env.DEV);
  const search = createSearch(env);
  return {
    dev,
    siteKey: env.TURNSTILE_SITE_KEY?.trim() || "0x4AAAAAAFRUoj5qDpf7XyIW",
    searchReady: searchConfigured(env),
    async limit(name, key) {
      const binding = name === "ASK_LIMIT" ? env.ASK_LIMIT : env.SEARCH_LIMIT;
      const result = await binding.limit({ key });
      return result.success;
    },
    verify: (token, ip) =>
      verifyTurnstile({
        secret: env.TURNSTILE_SECRET ?? "",
        token,
        ip,
        dev,
      }),
    async takeToken(hash) {
      return stubOf(env).takeToken(hash);
    },
    async rememberToken(hash) {
      return stubOf(env).rememberToken(hash);
    },
    async claim() {
      return stubOf(env).claim();
    },
    async claimSearch() {
      return stubOf(env).claimSearch();
    },
    async refund() {
      await stubOf(env).refund();
    },
    async refundSearch() {
      await stubOf(env).refundSearch();
    },
    search: (query) => search.search(query),
    aiSearch: (query) => search.aiSearch(query),
  };
}
