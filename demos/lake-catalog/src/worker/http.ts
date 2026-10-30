import { capMessage, type ClaimResult } from "../shared/cap";
import { duckdbSnippet, signConnection, signJwt, verifyConnection, verifyJwt } from "../shared/jwt";
import { decide, isCatalog, isRole, type Explain, type Role } from "../shared/policy";
import type { CatalogId } from "../shared/rows";
import type { MapPayload } from "./map";
import type { QueryResult } from "../shared/sql";
import { clientIp, rateLimitKey } from "./limits";
import {
  connectionResponse,
  decodeQuack,
  emptyFetch,
  encodeQuack,
  errorResponse,
  QUACK_MIME,
  resultResponse,
  successResponse,
} from "./quack";
import { allowedWidgetHost, type VerifyResult } from "./turnstile";
import { MessageType, type QuackMessage } from "@quack-protocol/sdk";

const MAX_QUACK_BYTES = 1_000_000;
const MAX_JSON_BYTES = 8_000;
const MAX_SQL = 2000;

export type { MapPayload };

export type Deps = {
  dev: boolean;
  siteKey: string;
  jwtSecret: string | null;
  connectionSecret: string | null;
  bucket: string;
  ttlSeconds: number;
  now: () => number;
  limit: (name: "QUERY_LIMIT" | "TOKEN_LIMIT" | "READ_LIMIT", key: string) => Promise<boolean>;
  verify: (token: string, ip: string) => Promise<VerifyResult>;
  charge: () => Promise<ClaimResult>;
  resolveCatalog: (catalog: CatalogId) => Promise<boolean>;
  queryCatalog: (catalog: CatalogId, role: Role, sql: string) => Promise<QueryResult>;
  status: () => Promise<MapPayload>;
  reset: () => Promise<void>;
};

function json(body: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
}

function quackResponse(bytes: Uint8Array, explain: Explain | null, status = 200): Response {
  const headers = new Headers();
  headers.set("content-type", QUACK_MIME);
  headers.set("cache-control", "no-store");
  headers.set("access-control-expose-headers", "x-lake-explain");
  if (explain) headers.set("x-lake-explain", JSON.stringify(explain));
  return new Response(bytes, { status, headers });
}

async function limited(request: Request, deps: Deps, name: "QUERY_LIMIT" | "TOKEN_LIMIT" | "READ_LIMIT"): Promise<Response | null> {
  try {
    const ok = await deps.limit(name, rateLimitKey(clientIp(request)));
    if (!ok) return json({ error: "Too many requests from this network. Wait a minute.", code: "rate_limited" }, 429);
    return null;
  } catch (err) {
    console.log(JSON.stringify({ event: "rate_limit_failed", name: err instanceof Error ? err.name : "error" }));
    return json({ error: "Rate limiting is unavailable. Try again shortly.", code: "rate_limit_unavailable" }, 503);
  }
}

function configured(deps: Deps): Response | null {
  if (!deps.jwtSecret || !deps.connectionSecret) {
    return json({ error: "This demo is not configured.", code: "unconfigured" }, 503);
  }
  return null;
}

function capExplain(role: Role, catalog: CatalogId, claim: ClaimResult): Explain {
  return {
    effect: "deny",
    role,
    catalog,
    reasons: [capMessage(claim.cap)],
    executedSql: null,
    columns: [],
  };
}

export async function readCappedBytes(request: Request, max: number): Promise<Uint8Array | Response> {
  const declared = request.headers.get("content-length");
  if (declared !== null && declared !== "") {
    const n = Number(declared);
    if (!Number.isFinite(n) || n < 0 || n > max) return json({ error: "The request is too large.", code: "too_large" }, 413);
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => undefined);
        return json({ error: "The request is too large.", code: "too_large" }, 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function readJson(request: Request): Promise<unknown | Response> {
  const bytes = await readCappedBytes(request, MAX_JSON_BYTES);
  if (bytes instanceof Response) return bytes;
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return json({ error: "The request was not JSON.", code: "bad_json" }, 400);
  }
}

export async function handleRequest(request: Request, deps: Deps, path: string): Promise<Response | null> {
  const url = new URL(request.url);
  if (!allowedWidgetHost(url.hostname, deps.dev)) {
    return json({ error: "This demo is unavailable.", code: "unavailable" }, 503);
  }
  if (request.method === "GET" && path === "/api/health") {
    return json({ ok: true, protocol: "quack", endpoint: "/quack" });
  }
  if (request.method === "GET" && path === "/api/config") {
    return json({ siteKey: deps.siteKey, dev: deps.dev });
  }
  if (request.method === "GET" && path === "/api/map") {
    const blocked = await limited(request, deps, "READ_LIMIT");
    if (blocked) return blocked;
    try {
      return json(await deps.status());
    } catch (err) {
      console.log(JSON.stringify({ event: "map_failed", name: err instanceof Error ? err.name : "error" }));
      return json({ error: "The catalog map is unavailable.", code: "map_unavailable" }, 502);
    }
  }
  if (request.method === "POST" && path === "/api/token") {
    const missing = configured(deps);
    if (missing) return missing;
    const blocked = await limited(request, deps, "TOKEN_LIMIT");
    if (blocked) return blocked;
    const body = await readJson(request);
    if (body instanceof Response) return body;
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const role = typeof record.role === "string" ? record.role : "";
    const catalog = typeof record.catalog === "string" ? record.catalog : "orders";
    const turnstile = typeof record.turnstile === "string" ? record.turnstile : "";
    if (!isRole(role) || !isCatalog(catalog)) return json({ error: "Pick a role and a catalog.", code: "bad_role" }, 400);
    const verdict = await deps.verify(turnstile, clientIp(request));
    if (verdict === "unconfigured") return json({ error: "This demo is not configured.", code: "unconfigured" }, 503);
    if (verdict !== "ok") return json({ error: "The check failed. Try again.", code: "turnstile" }, 401);
    const known = await deps.resolveCatalog(catalog);
    if (!known) return json({ error: "Unknown catalog.", code: "unknown_catalog" }, 404);
    const now = Math.floor(deps.now() / 1000);
    const exp = now + deps.ttlSeconds;
    const token = await signJwt(deps.jwtSecret as string, { role, catalog, iat: now, exp });
    const secure = url.protocol === "https:";
    const snippet = duckdbSnippet({
      token,
      host: url.hostname,
      port: secure ? "443" : url.port || "80",
      secure,
    });
    console.log(JSON.stringify({ event: "token", role, catalog }));
    return json({ token, expiresAt: new Date(exp * 1000).toISOString(), role, catalog, snippet });
  }
  if (request.method === "POST" && path === "/quack") {
    return handleQuack(request, deps);
  }
  return null;
}

async function handleQuack(request: Request, deps: Deps): Promise<Response> {
  const missing = configured(deps);
  if (missing) return missing;
  const buffer = await readCappedBytes(request, MAX_QUACK_BYTES);
  if (buffer instanceof Response) return buffer;
  let message: QuackMessage;
  try {
    message = decodeQuack(buffer);
  } catch (err) {
    console.log(JSON.stringify({ event: "quack_decode_failed", name: err instanceof Error ? err.name : "error" }));
    return json({ error: "The Quack message could not be read.", code: "bad_quack" }, 400);
  }

  if (message.type === MessageType.CONNECTION_REQUEST) {
    const token = message.authString ?? "";
    const claims = await verifyJwt(deps.jwtSecret as string, token, Math.floor(deps.now() / 1000));
    if (!claims) {
      const explain: Explain = {
        effect: "deny",
        role: "guest",
        catalog: "orders",
        reasons: ["The catalog token is missing or expired."],
        executedSql: null,
        columns: [],
      };
      return quackResponse(errorResponse(message, explain.reasons[0] ?? "Denied.", "denied"), explain);
    }
    const known = await deps.resolveCatalog(claims.catalog);
    if (!known) {
      const explain: Explain = {
        effect: "deny",
        role: claims.role,
        catalog: claims.catalog,
        reasons: ["Unknown catalog."],
        executedSql: null,
        columns: [],
      };
      return quackResponse(errorResponse(message, "Unknown catalog."), explain);
    }
    const connectionId = await signConnection(deps.connectionSecret as string, {
      catalog: claims.catalog,
      role: claims.role,
      exp: claims.exp,
      sid: crypto.randomUUID().replaceAll("-", ""),
    });
    console.log(JSON.stringify({ event: "connect", role: claims.role, catalog: claims.catalog }));
    return quackResponse(connectionResponse(message, connectionId), null);
  }

  if (
    message.type === MessageType.HEARTBEAT_REQUEST ||
    message.type === MessageType.DISCONNECT_MESSAGE ||
    message.type === MessageType.ACKNOWLEDGEMENT ||
    message.type === MessageType.CANCEL_REQUEST
  ) {
    return quackResponse(successResponse(message), null);
  }

  if (message.type === MessageType.FETCH_REQUEST) {
    return quackResponse(emptyFetch(message), null);
  }

  if (message.type !== MessageType.PREPARE_REQUEST) {
    return quackResponse(errorResponse(message, "This demo does not accept that Quack message."), null);
  }

  const session = await verifyConnection(
    deps.connectionSecret as string,
    message.connectionId ?? "",
    Math.floor(deps.now() / 1000),
  );
  if (!session) {
    const explain: Explain = {
      effect: "deny",
      role: "guest",
      catalog: "orders",
      reasons: ["The Quack session is missing or expired."],
      executedSql: null,
      columns: [],
    };
    return quackResponse(errorResponse(message, explain.reasons[0] ?? "Denied."), explain);
  }

  const blocked = await limited(request, deps, "QUERY_LIMIT");
  if (blocked) return blocked;

  const sql = message.sql ?? "";
  if (sql.length > MAX_SQL) {
    const explain: Explain = {
      effect: "deny",
      role: session.role,
      catalog: session.catalog,
      reasons: ["The query is too long."],
      executedSql: null,
      columns: [],
    };
    console.log(JSON.stringify({ event: "query", catalog: session.catalog, role: session.role, effect: "deny" }));
    return quackResponse(errorResponse(message, explain.reasons[0] ?? "Denied.", message.connectionId), explain);
  }

  const claim = await deps.charge();
  if (!claim.ok) {
    const explain = capExplain(session.role, session.catalog, claim);
    console.log(JSON.stringify({ event: "cap", catalog: session.catalog, role: session.role }));
    return quackResponse(errorResponse(message, explain.reasons[0] ?? "Denied.", message.connectionId), explain);
  }

  let result: QueryResult;
  try {
    result = await deps.queryCatalog(session.catalog, session.role, sql);
  } catch (err) {
    console.log(JSON.stringify({ event: "query_failed", name: err instanceof Error ? err.name : "error" }));
    const explain = decide(session.role, "SELECT region FROM orders", session.catalog);
    explain.effect = "deny";
    explain.reasons = ["The catalog could not run the statement."];
    explain.executedSql = null;
    explain.columns = [];
    return quackResponse(errorResponse(message, explain.reasons[0] ?? "Denied.", message.connectionId), explain);
  }

  if (result.explain.effect === "deny" || !result.explain.executedSql) {
    const reason = result.explain.reasons[0] ?? "Denied.";
    return quackResponse(errorResponse(message, reason, message.connectionId), result.explain);
  }
  return quackResponse(resultResponse(message, result), result.explain);
}

export { encodeQuack };
