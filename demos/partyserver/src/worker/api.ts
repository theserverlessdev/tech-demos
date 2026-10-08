import { getServerByName } from "partyserver";
import { BASE_PATH, MAX_CONNECTIONS, MAX_DOC_BYTES, MAX_STROKES, ROOM_ID, ROOM_TTL_MS, type CreatedRoom, type PublicConfig, type RoomStatus } from "../shared/protocol";
import { internalHeader, type BoardRoom } from "./room";
import { assessTurnstile, verifyTurnstile } from "./turnstile";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
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

function newRoomId(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let id = "";
  for (const byte of bytes) id += ALPHABET[byte % ALPHABET.length];
  return id;
}

async function roomStub(env: Env, id: string): Promise<DurableObjectStub<BoardRoom>> {
  if (!ROOM_ID.test(id)) throw new HttpError(404, "not_found", "Unknown room.");
  return getServerByName(env.BoardRoom, id);
}

async function callRoom(stub: DurableObjectStub<BoardRoom>, path: string, method: string): Promise<Response> {
  return stub.fetch(`https://board${path}`, { method, headers: { [internalHeader]: "1" } });
}

export async function handleApi(request: Request, env: Env, pathname: string): Promise<Response> {
  const method = request.method;
  const host = new URL(request.url).hostname;

  if (pathname === "/api/health" && method === "GET") {
    return json({ ok: true, party: "board-room", hibernation: true });
  }

  if (pathname === "/api/config" && method === "GET") {
    const secret = env.TURNSTILE_SECRET ?? "";
    const siteKey = (env.TURNSTILE_SITE_KEY ?? "").trim();
    const createOpen = assessTurnstile({ secret, siteKey, allowTestCredentials: testCredentialsAllowed(env) }) === "open";
    const body: PublicConfig = {
      siteKey: createOpen ? siteKey : null,
      createOpen,
      maxConnections: MAX_CONNECTIONS,
      maxStrokes: MAX_STROKES,
      maxDocBytes: MAX_DOC_BYTES,
      ttlMs: positiveTtl(env.ROOM_TTL_MS),
      party: "board-room",
    };
    return json(body);
  }

  if (pathname === "/api/rooms" && method === "POST") {
    const secret = env.TURNSTILE_SECRET ?? "";
    const siteKey = env.TURNSTILE_SITE_KEY ?? "";
    if (assessTurnstile({ secret, siteKey, allowTestCredentials: testCredentialsAllowed(env) }) !== "open") {
      throw new HttpError(503, "closed", "Room creation is off until Turnstile is configured for this host.");
    }
    const { success } = await env.CREATE_LIMIT.limit({ key: clientIp(request) });
    if (!success) throw new HttpError(429, "rate_limited", "Too many rooms from this address. Wait a minute.");
    const body = await readJson(request);
    const token = typeof body.turnstileToken === "string" ? body.turnstileToken : "";
    // The always-pass test secret accepts every token siteverify sees, so reject a bad shape first.
    if (!/^[A-Za-z0-9._-]{20,2048}$/.test(token)) throw new HttpError(400, "invalid", "Missing Turnstile token.");
    const ok = await verifyTurnstile(secret, token, clientIp(request), host);
    if (!ok) throw new HttpError(403, "turnstile", "Turnstile could not verify this browser.");
    const id = newRoomId();
    const stub = await roomStub(env, id);
    const created = await callRoom(stub, "/init", "POST");
    if (!created.ok) throw new HttpError(502, "room", "The room did not start.");
    const meta = (await created.json()) as CreatedRoom;
    return json(meta, 201);
  }

  const match = pathname.match(/^\/api\/rooms\/([^/]+)$/);
  if (match && method === "GET") {
    const id = decodeURIComponent(match[1] ?? "");
    if (!ROOM_ID.test(id)) throw new HttpError(404, "not_found", "Unknown room.");
    const stub = await roomStub(env, id);
    const res = await callRoom(stub, "/status", "GET");
    if (!res.ok) throw new HttpError(502, "room", "The room did not answer.");
    const status = (await res.json()) as RoomStatus;
    if (status.expired || status.createdAt === 0) throw new HttpError(404, "not_found", "That room is gone.");
    return json(status);
  }

  throw new HttpError(404, "not_found", "Unknown API route.");
}

/** `.dev.vars` sets this to 1. Production wrangler.jsonc leaves it "0". */
function testCredentialsAllowed(env: Env): boolean {
  return (env.TURNSTILE_LOCAL as string) === "1";
}

function positiveTtl(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 60_000) return ROOM_TTL_MS;
  return parsed;
}

export { BASE_PATH };
