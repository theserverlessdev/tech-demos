import { CAP_MESSAGE } from "../shared/cap";
import { iceServersFromEnv } from "../shared/ice";
import {
  CID,
  DAILY_CAP,
  MAX_PEERS,
  ROOM_ID,
  ROOM_TTL_MS,
  randomRoomId,
  type CreatedRoom,
  type PublicConfig,
} from "../shared/protocol";
import type { Env } from "./env";
import { allowedRequestOrigin } from "./origin";
import { assessTurnstile, localEnabled, verifyTurnstile } from "./turnstile";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > 4096) throw new HttpError(413, "body", "That request is too large.");
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "body", "Send a JSON body.");
  }
}

function capStub(env: Env) {
  return env.CREATE_CAP.get(env.CREATE_CAP.idFromName("global"));
}

export async function handleApi(request: Request, env: Env, path: string, local: boolean): Promise<Response> {
  const ip = clientIp(request);
  if (path === "/api/health") {
    await limit(env.READ_LIMIT, ip, "Too many reads. Wait a minute.");
    return json({ ok: true });
  }
  if (path === "/api/config") {
    await limit(env.READ_LIMIT, ip, "Too many reads. Wait a minute.");
    return json(publicConfig(env));
  }
  if (path === "/api/rooms" && request.method === "POST") {
    return json(await createRoom(request, env, ip, local), 201);
  }
  throw new HttpError(404, "route", "Not found.");
}

export async function connectRoom(request: Request, env: Env, id: string, local: boolean): Promise<Response> {
  if (!ROOM_ID.test(id)) return new Response("Not found", { status: 404 });
  if (!allowedRequestOrigin(request.headers.get("origin"), local)) {
    return new Response("That origin is not allowed.", { status: 403 });
  }
  const ip = clientIp(request);
  const { success } = await env.CONNECT_LIMIT.limit({ key: ip });
  if (!success) return new Response("Too many connections. Wait a minute.", { status: 429 });
  const now = Date.now();
  const known = await capStub(env).known(id, now);
  if (!known) return new Response("Not found", { status: 404 });
  const stub = env.ROOM.get(env.ROOM.idFromName(id));
  return stub.fetch(request);
}

function publicConfig(env: Env): PublicConfig {
  const ice = iceServersFromEnv(env);
  const siteKey = env.TURNSTILE_SITE_KEY?.trim() || null;
  return {
    siteKey,
    local: localEnabled(env.TURNSTILE_LOCAL),
    ttlMs: ROOM_TTL_MS,
    maxPeers: MAX_PEERS,
    dailyCap: DAILY_CAP,
    stun: "stun:stun.cloudflare.com:3478",
    turn: ice.turn,
  };
}

async function limit(binding: Env["READ_LIMIT"], ip: string, message: string): Promise<void> {
  const { success } = await binding.limit({ key: ip });
  if (!success) throw new HttpError(429, "rate", message);
}

async function createRoom(request: Request, env: Env, ip: string, local: boolean): Promise<CreatedRoom> {
  if (!allowedRequestOrigin(request.headers.get("origin"), local)) {
    throw new HttpError(403, "origin", "That origin is not allowed.");
  }
  const secret = env.TURNSTILE_SECRET ?? "";
  const siteKey = env.TURNSTILE_SITE_KEY ?? "";
  if (assessTurnstile({ secret, siteKey, local }) === "closed") {
    throw new HttpError(503, "turnstile", "Room creation is unavailable until the Turnstile secret is set.");
  }
  await limit(env.CREATE_LIMIT, ip, "Too many rooms from this network. Wait a minute.");
  const body = (await readJson(request)) as { token?: unknown; creatorCid?: unknown };
  const token = typeof body.token === "string" ? body.token : "";
  const creatorCid = typeof body.creatorCid === "string" ? body.creatorCid : "";
  if (!CID.test(creatorCid)) throw new HttpError(400, "peer", "The browser id is missing.");
  const checked = await verifyTurnstile({ secret, token, ip, local });
  if (checked !== "ok") throw new HttpError(403, "turnstile", "The check failed. Try again.");

  const cap = capStub(env);
  const now = Date.now();
  const claim = await cap.claim(now);
  if (!claim.ok) throw new HttpError(429, "cap", CAP_MESSAGE);

  let reserved = "";
  try {
    const reservedRoom = await reserveId(cap, now);
    reserved = reservedRoom.id;
    const created = await env.ROOM.get(env.ROOM.idFromName(reservedRoom.id)).create({ creatorCid, now });
    if (created.expiresAt !== reservedRoom.exp) await cap.note(reservedRoom.id, created.expiresAt, now);
    return { id: reservedRoom.id, expiresAt: created.expiresAt, remaining: claim.remaining };
  } catch (err) {
    if (reserved) await cap.forget(reserved);
    await cap.refund(now);
    if (err instanceof HttpError) throw err;
    throw new HttpError(503, "room", "The room could not be opened. Try again.");
  }
}

async function reserveId(cap: ReturnType<typeof capStub>, now: number): Promise<{ id: string; exp: number }> {
  const exp = now + ROOM_TTL_MS;
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = randomRoomId();
    if (await cap.note(id, exp, now)) return { id, exp };
  }
  throw new HttpError(503, "id", "Could not open a room. Try again.");
}

